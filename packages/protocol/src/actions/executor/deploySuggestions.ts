import { z } from '../../zodRuntimePolicy.js';
import { REGISTRY_ACTION_OUTPUT_SCHEMAS_V1 } from '../../registries/registryActionsV1.js';
import type { RegistryListPageV1 } from '../../registries/registryListV1.js';
import { CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1 } from '../../connect/configurationActionsV1.js';
import { MachineSetupCombinedPlanResultV1Schema } from '../../machines/managed/actionsV1.js';
import { readDeployHostReadiness } from '../../deployments/deployHostReadiness.js';
import type { DeploySuggestionCatalogV1 } from '../../deployments/suggestions/deploySuggestionsV1.js';
import type { ActionId } from '../actionIds.js';
import type { ActionExecuteResult, ActionExecutorContext, ActionExecutorDeps } from './types.js';

const machineRows = z.looseObject({ items: z.array(z.looseObject({ machineId: z.string(), label: z.string(),
    active: z.optional(z.boolean()), named: z.optional(z.boolean()), presence: z.optional(z.enum(['online', 'offline', 'unknown'])), homeDir: z.optional(z.string()) })) });
type Section = NonNullable<DeploySuggestionCatalogV1['issues']>[number]['section'];

/** One finite read composition. Catalog owners retain their original placement and transport. */
export async function readDeploySuggestionCatalogV1(context: ActionExecutorContext, deps: ActionExecutorDeps,
    execute: (id: ActionId, input: unknown) => Promise<ActionExecuteResult>): Promise<DeploySuggestionCatalogV1> {
    const catalog: DeploySuggestionCatalogV1 = { starters: [], apps: [], targets: [], stores: [], forges: [], machines: [], connectedAccounts: [], issues: [] };
    const issues = catalog.issues!;
    async function read(id: ActionId, input: unknown, section: Section) {
        const answer = await execute(id, input);
        if (!answer.ok) { issues.push({ section, code: answer.errorCode }); return null; }
        return answer.result;
    }
    async function list(kind: 'starter' | 'app', cursor?: string, sourceId?: string): Promise<RegistryListPageV1[]> {
        const raw = await read('registries.items.list', { kind, ...(cursor ? { cursor } : {}), ...(sourceId ? { sourceIds: [sourceId] } : {}) }, kind === 'starter' ? 'starters' : 'apps');
        return raw === null ? [] : REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.list'].parse(raw).pages;
    }
    async function descriptors<T>(section: Section, readOwner: ((context: ActionExecutorContext) => Promise<T>) | undefined) {
        if (!readOwner) { issues.push({ section, code: 'unsupported_action' }); return null; }
        try { return await readOwner(context); }
        catch (error: unknown) {
            const code = error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
                ? error.code : 'action_failed';
            issues.push({ section, code }); return null;
        }
    }
    const [starterPages, appPages, accounts, machines, targetRead, forgeRead] = await Promise.all([
        list('starter'), list('app'), read('connectedServices.accounts.list', {}, 'connectedAccounts'),
        read('machines.list', { refresh: true }, 'machines'),
        descriptors('targets', deps.deploymentSuggestionTargets),
        descriptors('forges', deps.deploymentSuggestionForges),
    ]);
    if (targetRead) { catalog.targets = targetRead.targets; catalog.stores = targetRead.stores; }
    if (forgeRead) catalog.forges = forgeRead;
    // A registry cursor belongs to its source. Keep the owner's paging rather than rereading other sources.
    async function completePages(kind: 'starter' | 'app', pages: RegistryListPageV1[]) {
        await Promise.all(pages.map(async page => {
            let cursor: string | null | undefined = page.nextCursor;
            while (cursor) {
                const next = await list(kind, cursor, page.sourceId);
                pages.push(...next);
                cursor = next.find(candidate => candidate.sourceId === page.sourceId)?.nextCursor;
            }
        }));
    }
    await Promise.all([completePages('starter', starterPages), completePages('app', appPages)]);
    const items = (pages: readonly RegistryListPageV1[], section: 'starters' | 'apps') => pages.flatMap(page => {
        if (page.status.state !== 'ok') issues.push({ section, code: page.status.state });
        return page.items.filter(item => !item.problem);
    });
    catalog.starters = items(starterPages, 'starters').map(item => ({ id: JSON.stringify([item.sourceId, item.itemId]),
        title: item.title, sourceId: item.sourceId, itemId: item.itemId, ...(item.starterDeploy ? { deploy: item.starterDeploy } : {}) }));
    catalog.apps = items(appPages, 'apps').map(item => ({ id: JSON.stringify([item.sourceId, item.itemId]),
        title: item.title, sourceId: item.sourceId, itemId: item.itemId }));
    if (accounts !== null) catalog.connectedAccounts = CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1['connectedServices.accounts.list']
        .parse(accounts).accounts.map(row => ({ account: row.account.ref, health: row.health }));
    if (machines !== null) catalog.machines = await Promise.all(machineRows.parse(machines).items.map(async machine => {
        const online = machine.presence ? machine.presence === 'online' : machine.active === true;
        let readiness: DeploySuggestionCatalogV1['machines'][number]['readiness'] = 'unknown';
        const homeId = context.serverIdentityId ?? context.serverId;
        if (online && homeId) {
            const raw = await read('machines.setup.plan', { homeId, machineId: machine.machineId,
                targets: [{ homeId, machineId: machine.machineId }], selectedMachineId: machine.machineId }, 'machines');
            if (raw !== null) {
                const plan = MachineSetupCombinedPlanResultV1Schema.safeParse(raw);
                if (plan.success) readiness = readDeployHostReadiness(plan.data, machine.machineId);
            }
        }
        // `named: false` is the Machine owner saying its label is a placeholder (name still loading), not a name.
        return { machineId: machine.machineId, ...(machine.named === false ? {} : { label: machine.label }), online, readiness,
            ...(machine.homeDir ? { homeDir: machine.homeDir } : {}) };
    }));
    // Starters are package content an online Machine reads: with none online an empty list has that cause, the same
    // `needs_machine` a source reports when it cannot be read (AUTO-LIVE F2).
    if (machines !== null && catalog.starters.length === 0 && !catalog.machines.some(machine => machine.online)
        && !issues.some(issue => issue.section === 'starters')) issues.push({ section: 'starters', code: 'needs_machine' });
    return catalog;
}
