import { SkillListItemV1Schema, type SkillListItemV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import type { PromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import type { SkillsLibrary } from '@/sync/domains/skills/useSkillsLibrary';
import { createMachineFixture } from '@/dev/testkit';
import { createPlainArtifactHomeFixture } from './artifactStoreBoundary';
import { createPromptLibraryCatalogBoundary } from './promptLibraryCatalogBoundary';
import { createRootLayoutFeaturesResponse } from '../fixtures/featureFixtures';
import { capabilityDismissalState } from '@/sync/domains/state/persistentUiState';

export function createSkillsSurfaceItem(skillId: string, overrides: Partial<SkillListItemV1> = {}): SkillListItemV1 {
    return SkillListItemV1Schema.parse({ skillId, name: skillId, description: `${skillId} instructions`, revision: '1:1',
        rules: [{ id: `${skillId}-on`, skillId, target: { t: 'allMachines' }, enabled: true, createdAt: 1, updatedAt: 1 }],
        trust: 'text_only', cost: { descriptionTokens: 2, bodyTokens: 20 }, provenance: { kind: 'written' }, modified: false,
        updatePolicy: 'manual', createdAt: 1, migratedFromContext: false, userInvocable: true, folderId: null, ...overrides });
}

export function createSkillsSurfaceLibrary(items: readonly SkillListItemV1[], overrides: Partial<SkillsLibrary> = {}): SkillsLibrary {
    return { scope: null, status: 'ready', items, stale: false, errorCode: null, usageObservedSince: null, retry: () => {}, ...overrides };
}

/** HTTP/native boundaries are installed by the suite before importing the real surface graph. */
export async function createSkillsSurfaceHarness(origin: string, records: readonly PromptLibraryRecordV1[] = []) {
    const catalog = createPromptLibraryCatalogBoundary({ records });
    const externalRequests: string[] = [];
    const home = await createPlainArtifactHomeFixture(origin, {
        serverFeatures: createRootLayoutFeaturesResponse(),
        handleRequest: async (path, init) => path === '/v2/account/settings/history'
            ? Response.json({ snapshots: [] }) : catalog.handle(path, init),
        handleExternalRequest: async url => {
            externalRequests.push(new URL(url).pathname);
            return Response.json({ version: 1, items: [] });
        },
    });
    const { storage } = await import('@/sync/domains/state/storage');
    const { adoptHomeProfile, setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
    const qualified = await adoptHomeProfile({ source: 'manual', descriptor: { v: 1,
        homeServerIdentityId: `srv_${new URL(origin).hostname.replaceAll('.', '_')}`, canonicalServerUrl: origin, revision: 1,
        endpoints: [{ kind: 'https', url: origin }] } });
    if (!qualified.serverIdentityId) throw new Error('Expected qualified Home');
    await setActiveServerId(qualified.id);
    const scope = { serverId: qualified.serverIdentityId, accountId: 'artifact-account' };
    const machine = (id: string, offline: boolean) => createMachineFixture({ id, active: !offline, activeAt: offline ? 1 : Date.now(),
        metadata: { ...createMachineFixture().metadata!, displayName: id, host: id, platform: 'linux',
            agentInventory: { checkedAt: 2, installedAgentIds: ['codex'] } } });
    const machines = [machine('nl2', false), machine('away', true)];
    storage.setState({ settingsScope: scope, profileScope: scope, isDataReady: true, artifactsLoaded: true,
        machines: Object.fromEntries(machines.map(machine => [machine.id, machine])),
        machineListByServerId: { [scope.serverId]: machines }, machineListStatusByServerId: { [scope.serverId]: 'idle' } });
    storage.getState().applyMachines(machines, true, { sourceServerId: scope.serverId, sourceAccountId: scope.accountId });
    capabilityDismissalState.remove('skillsFirstRunDecidedAt');
    return { ...home, scope, catalog, storage, externalRequests };
}

export type SeededSkill = Readonly<{
    id: string;
    /** SKILL.md text; defaults to a minimal skill named after the id. */
    text?: string;
    /** Other files in this stored skill, alongside SKILL.md. */
    files?: readonly Readonly<{ path: string; content: string }>[];
    /** Extra header fields, such as a `skillLock` for a skill added from a link. */
    header?: Record<string, unknown>;
    /** With a `skillLock` header: imported from exactly this content, so the library reads it unmodified. */
    unmodified?: boolean;
}>;

/**
 * A Home whose library holds real stored skills: the artifact store and prompt-library catalog are the
 * HTTP boundaries, so `useSkillsLibrary` and every mounted skill Action run their production path.
 */
export async function createSeededSkillsHome(origin: string, options: Readonly<{
    skills: readonly SeededSkill[];
    records?: readonly PromptLibraryRecordV1[];
    handleExternalRequest?: (url: string) => Promise<Response | null>;
    handleRequest?: (path: string, init?: RequestInit) => Promise<Response | null>;
}>) {
    const [{ PromptBundleArtifactHeaderV1Schema, PromptBundleBodyV1Schema }, { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent },
        { encodeBase64 }, { computePromptBundleDigestV1 }] = await Promise.all([
        import('@happier-dev/protocol/prompts/library/promptBundleSchemas'),
        import('@happier-dev/protocol/storage/artifactStoredContent'),
        import('@happier-dev/protocol/crypto/base64'),
        import('@happier-dev/protocol/prompts/library/promptLibraryDigests'),
    ]);
    const catalog = createPromptLibraryCatalogBoundary({ records: options.records });
    const home = await createPlainArtifactHomeFixture(origin, {
        serverFeatures: createRootLayoutFeaturesResponse(),
        handleExternalRequest: options.handleExternalRequest,
        handleRequest: async (path, init) => await options.handleRequest?.(path, init) ?? (path === '/v2/account/settings/history'
            ? Response.json({ snapshots: [] }) : catalog.handle(path, init)),
    });
    for (const skill of options.skills) {
        const text = skill.text ?? `---\nname: ${skill.id}\ndescription: ${skill.id} instructions.\n---\n\n# ${skill.id}\n`;
        const body = PromptBundleBodyV1Schema.parse({ v: 1, createdAtMs: 1, updatedAtMs: 1,
            entries: [{ path: 'SKILL.md', content: text }, ...(skill.files ?? [])].map(file => ({ path: file.path,
                contentKind: 'utf8', contentBase64: encodeBase64(new TextEncoder().encode(file.content)) })) });
        const lock = skill.header?.skillLock as Record<string, unknown> | undefined;
        const header = PromptBundleArtifactHeaderV1Schema.parse({ v: 1, kind: 'prompt_bundle.v2', title: skill.id,
            bundleSchemaId: 'skills.skill_md_v1', ...skill.header,
            ...(lock && skill.unmodified ? { skillLock: { ...lock, importedDigest: computePromptBundleDigestV1(body) } } : {}) });
        const seeded = await home.boundary.handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({ id: skill.id,
            header: encodePlainArtifactStoredContent(header), body: encodePlainArtifactStoredContent({ body: JSON.stringify(body) }),
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER }) });
        if (seeded?.status !== 200) throw new Error(`Could not seed skill ${skill.id}`);
    }
    const { storage } = await import('@/sync/domains/state/storage');
    // Seeding the Home does not publish the client's complete Artifact inventory.
    storage.setState({ isDataReady: true, artifactsLoaded: false });
    return { ...home, catalog, storage };
}
