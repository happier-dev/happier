import { afterEach, describe, expect, it } from 'vitest';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { buildApprovalPreviewSummary } from '@happier-dev/protocol/actions/actionExecutor';
import { preloadTranslations, setPreferredLanguageFromSettings, t } from '@/text';
import { presentActionApproval, readActionApprovalSubject } from './actionApprovalPresentation';
import { buildRoleCatalog } from '@/sync/domains/roles/roleCatalog';
import { BUILT_IN_ROLES_V1 } from '@happier-dev/protocol/prompts/roles/builtInRolesV1';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { readActionApprovalReview } from './actionApprovalReview';

afterEach(() => setPreferredLanguageFromSettings('en'));

describe('the shared Action approval presentation owner', () => {
    it('summarizes a declared Service Start by its Service and project, never by the agent-facing Action description', () => {
        const actionArgs = getActionSpec('localServices.launcher.start').inputSchema.parse({
            machineId: 'worker', targetId: 'project-service:a',
            workspace: { serverId: 'home', machineId: 'devbox', workspaceId: 'checkout', rootPath: '/home/dev/qaS-studio' },
            declaration: { workspaceRefId: 'checkout', selection: { kind: 'manifest', name: 'httpPort' } },
        });
        const summary = presentActionApproval({ actionId: 'localServices.launcher.start', actionArgs }).summary;
        expect(summary).toBe('Start httpPort from qaS-studio.');
    });
    it('names the Service a Stop or Restart confirmation acts on, without inferring irreversibility', async () => {
        const target = { kind: 'managed_service', managedServiceId: 'managed-a', machineId: 'worker',
            declaration: { workspaceRefId: 'checkout', selection: { kind: 'manifest', name: 'httpPort' } } };
        const stopArgs = getActionSpec('localServices.actions.stopManaged').inputSchema.parse({ requestId: 'r1', target, action: 'stop_managed' });
        const restartArgs = getActionSpec('localServices.actions.restartManaged').inputSchema.parse({ requestId: 'r2', target, action: 'restart_managed' });
        // The request an Agent or the CLI creates carries the same Service name in its stored summary.
        expect(buildApprovalPreviewSummary(getActionSpec('localServices.actions.stopManaged'), stopArgs)).toBe('Stop httpPort.');
        expect(buildApprovalPreviewSummary(getActionSpec('localServices.actions.restartManaged'), restartArgs)).toBe('Restart httpPort.');
        // The confirmation names where the Service runs through the same Machine reference reader as other Machine Actions.
        expect(readActionApprovalSubject({ actionId: 'localServices.actions.stopManaged', actionArgs: stopArgs })).toEqual({ kind: 'machine', id: 'worker' });
        expect(readActionApprovalSubject({ actionId: 'localServices.actions.restartManaged', actionArgs: restartArgs })).toEqual({ kind: 'machine', id: 'worker' });
        const stop = presentActionApproval({ actionId: 'localServices.actions.stopManaged', actionArgs: stopArgs, subject: 'NLDW4-5-40-40' });
        expect(stop).toMatchObject({ title: 'Stop httpPort?', confirmLabel: 'Stop' });
        expect(stop.destructive).toBeFalsy();
        expect(stop.summary).toBe('This stops httpPort on NLDW4-5-40-40 now. Anything using its address loses its connection.');
        const restart = presentActionApproval({ actionId: 'localServices.actions.restartManaged', actionArgs: restartArgs, subject: 'NLDW4-5-40-40' });
        expect(restart).toMatchObject({ title: 'Restart httpPort?', confirmLabel: 'Restart' });
        expect(restart.destructive).toBeFalsy();
        expect(restart.summary).toContain('httpPort on NLDW4-5-40-40');
        // Without a known Machine the sentence stays true; without a declared name it says "this service".
        expect(presentActionApproval({ actionId: 'localServices.actions.stopManaged', actionArgs: stopArgs }).summary)
            .toBe('This stops httpPort now. Anything using its address loses its connection.');
        const unnamed = getActionSpec('localServices.actions.stopManaged').inputSchema.parse({
            requestId: 'r3', action: 'stop_managed', target: { kind: 'managed_service', managedServiceId: 'managed-b', machineId: 'worker' } });
        expect(presentActionApproval({ actionId: 'localServices.actions.stopManaged', actionArgs: unnamed }).title).toBe('Stop this service?');
        // The Action's own title (no input yet) stays the settings/catalog name.
        expect(presentActionApproval({ actionId: 'localServices.actions.stopManaged' }).title).toBe('Stop a local service');
        await preloadTranslations('fr');
        setPreferredLanguageFromSettings('fr');
        expect(presentActionApproval({ actionId: 'localServices.actions.stopManaged', actionArgs: stopArgs, subject: 'NLDW4-5-40-40' }))
            .toMatchObject({ title: 'Arrêter httpPort ?', confirmLabel: 'Arrêter' });
    });
    it('exposes literal reviewed file operands separately from their formatted approval description', () => {
        const actionArgs = { rootPath: '/repo', path: '/repo/ leading file ', content: 'aGVsbG8=' };
        const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'agent' }, actionId: 'daemon.filesystem.writeFile', actionArgs,
            summary: 'Review file write', executionOriginV1: { v: 1, authority: 'account_automation', surface: 'cli',
                caller: { kind: 'host' }, serverId: 'home-a', sessionId: 'session-a', machineId: 'machine-a',
                actionId: 'daemon.filesystem.writeFile', requestId: 'write-a' } });
        expect(readActionApprovalReview(request).workspaceFileSource).toEqual({ rootPath: actionArgs.rootPath, path: actionArgs.path });
        expect(readActionApprovalReview({ ...request, actionArgs: {} }).workspaceFileSource).toBeNull();
        expect(readActionApprovalReview({ ...request, actionId: 'account.name.set', actionArgs: { name: 'Name' } }).workspaceFileSource).toBeNull();
    });
    it('shares full-review requirements with compact approval decisions', () => {
        const requestFor = (actionId: string, actionArgs: unknown, preview?: unknown) => ApprovalRequestV2Schema.parse({
            v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1, createdBy: { surface: 'agent' },
            actionId, actionArgs, ...(preview ? { preview } : {}), summary: 'Review this request',
            executionOriginV1: { v: 1, authority: 'account_automation', surface: 'cli', caller: { kind: 'host' },
                serverId: 'home-a', sessionId: 'session-a', machineId: 'machine-a', actionId, requestId: 'request-a' },
        });
        const simple = requestFor('account.name.set', getActionSpec('account.name.set').inputSchema.parse({ name: 'Captain' }));
        expect(readActionApprovalReview(simple)).toMatchObject({ simple: true, admission: { status: 'available' } });
        const computer = requestFor('computer.capture', getActionSpec('computer.capture').inputSchema.parse({ machineId: 'machine-a' }),
            { computerApprovalDisplay: { machineDisplayName: 'Laptop', requiresTargetSelection: false,
                target: { kind: 'window', title: 'Editor' } } });
        const proposal = requestFor('machines.processes.kill', getActionSpec('machines.processes.kill').inputSchema.parse({
            machineId: 'machine-a', targets: [{ ref: 'process-a', expect: { level: 'proven' } }], tree: false,
        }));
        const prompt = requestFor('prompt_doc.update', getActionSpec('prompt_doc.update').inputSchema.parse({
            artifactId: 'doc-a', title: 'Instructions', markdown: 'New instruction',
        }));
        const capability = requestFor('session.capabilities.set', getActionSpec('session.capabilities.set').inputSchema.parse({
            sessionId: 'session-a', kind: 'skill', id: 'skill-a', state: 'on',
        }));
        const confidential = requestFor('computer.secret.fill', {
            serverId: 'home-a', sessionId: 'session-a', machineId: 'machine-a', purpose: 'Sign in', sourceId: 'source-a',
            target: { kind: 'window', displayId: ':77', pid: 123, windowId: 456 }, captureId: 'capture-a',
            geometry: { captureWidth: 1280, captureHeight: 800, nativeWidth: 1280, nativeHeight: 800,
                originX: 0, originY: 0, scaleX: 1, scaleY: 1, crop: { x: 0, y: 0, width: 1280, height: 800 } },
            field: { fieldId: 'password', focusId: 'focus-a' },
        });
        expect(readActionApprovalReview(proposal).resourceProposal).not.toBeNull();
        expect(readActionApprovalReview(prompt).promptDocUpdate).not.toBeNull();
        expect(readActionApprovalReview(capability).capabilityEnable).not.toBeNull();
        expect(readActionApprovalReview(confidential).confidential).not.toBeNull();
        for (const detailed of [computer, { ...computer, preview: undefined }, proposal, prompt, capability, confidential,
            { ...simple, actionArgs: {} }, { ...simple, status: 'rejected' as const },
        ]) expect(readActionApprovalReview(detailed).simple).toBe(false);
    });
    it('gives every approval surface the declared verb and irreversibility from the review owner', () => {
        const requestFor = (actionId: string) => ApprovalRequestV2Schema.parse({
            v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1, createdBy: { surface: 'agent' },
            actionId, actionArgs: {}, summary: 'Review this request',
            executionOriginV1: { v: 1, authority: 'account_automation', surface: 'cli', caller: { kind: 'host' },
                serverId: 'home-a', sessionId: 'session-a', machineId: 'machine-a', actionId, requestId: 'request-a' },
        });
        const irreversible = readActionApprovalReview(requestFor('plugins.uninstall'));
        expect(irreversible.approveVerb).toBe('Uninstall');
        expect(irreversible.irreversible).toBe(true);
        // A reversible Action keeps its verb but never reads as one that cannot be undone.
        const reversible = readActionApprovalReview(requestFor('updates.batch.start'));
        expect(reversible.approveVerb).toBe('Update');
        expect(reversible.irreversible).toBe(false);
        // An Action that declares no verb leaves each surface its own default word.
        const undeclared = readActionApprovalReview(requestFor('discussion.owner.transfer'));
        expect(undeclared.approveVerb).toBeNull();
        expect(undeclared.irreversible).toBe(false);
    });
    it('retains captured widget and plugin-page names in a request preview across locales', async () => {
        const actionArgs = { ref: { surface: { serverId: 'home', accountId: 'account', owner: {
            kind: 'pluginArea', pluginId: 'examples.widget-areas', pageId: 'overview', area: 'pinned',
        } }, instanceId: 'removed-copy' } };
        const preview = { widgetPresentation: { widgetName: 'Directory count', pageName: 'Widget areas', areaName: 'Pinned' } };
        for (const language of ['en', 'fr'] as const) {
            await preloadTranslations(language);
            setPreferredLanguageFromSettings(language);
            const presentation = presentActionApproval({ actionId: 'widgets.item.remove', actionArgs, preview });
            expect(presentation.summary).toContain('Directory count');
            expect(presentation.summary).toContain('Widget areas · Pinned');
            if (language === 'en') expect(presentation.summary).toBe('Remove “Directory count” from Widget areas · Pinned.');
        }
    });
    it("names a Machine terminal's folder by the readable path the confirming app supplies", () => {
        const actionArgs = { serverId: 'home-1', machineId: 'machine-1', terminalKey: 'machine:pane:1',
            cwd: '/home/ana/work/happier', cols: 100, rows: 24 };
        const formatPath = (path: string) => path.replace(/^\/home\/ana(?=\/)/u, '~');
        expect(presentActionApproval({ actionId: 'machines.terminal.open', actionArgs, formatPath }).summary).toContain('~/work/happier');
        // Without a known home the confirmation keeps the folder's own name, never the raw path.
        const bare = presentActionApproval({ actionId: 'machines.terminal.open', actionArgs }).summary;
        expect(bare).toContain('happier');
        expect(bare).not.toContain('/home/ana');
        // The Home only routes the request; the confirmation is about the Machine.
        expect(readActionApprovalSubject({ actionId: 'machines.terminal.open', actionArgs })).toEqual({ kind: 'machine', id: 'machine-1' });
    });

    it('leaves a workspace-sync request titled by its Action; its machine and folders read in Details', async () => {
        const actionArgs = { controllerMachineId: 'machine-1', relationshipId: 'relationship_1' };
        expect(readActionApprovalSubject({ actionId: 'workspace.sync.relationship.flush', actionArgs })).toBeUndefined();
        expect(presentActionApproval({ actionId: 'workspace.sync.relationship.flush', actionArgs }).title).toBe('Sync workspace now');
    });

    it('uses a declared localized verb and otherwise the generic approval verb regardless of subject', async () => {
        // No subject: the title is the Action's own words, so the button is the generic approval verb.
        for (const language of ['en', 'fr'] as const) {
            await preloadTranslations(language);
            setPreferredLanguageFromSettings(language);
            for (const actionId of ['machines.terminal.open', 'discussion.owner.transfer'] as const) {
                const presentation = presentActionApproval({ actionId });
                expect(presentation.confirmLabel).toBe(t('approvals.approve'));
                expect(presentation.confirmLabel).not.toBe(presentation.title);
            }
        }
        setPreferredLanguageFromSettings('en');
        // With a subject the title reads about the subject, so the button may still name the Action.
        const withSubject = presentActionApproval({ actionId: 'machines.terminal.open', subject: 'Devbox' });
        expect(withSubject.title).not.toBe(withSubject.confirmLabel);
        expect(withSubject.confirmLabel).toBe(t('approvals.approve'));
    });

    it('localizes the declared confirmation verb', async () => {
        expect(presentActionApproval({ actionId: 'session.draft.delete' }).confirmLabel).toBe('Delete');
        await preloadTranslations('fr');
        setPreferredLanguageFromSettings('fr');
        expect(presentActionApproval({ actionId: 'session.draft.delete' }).confirmLabel).toBe('Supprimer');
        // An id the catalog does not know has no Action title to borrow: the caller keeps its own default.
        expect(presentActionApproval({ actionId: 'plugin.unknown', authoredTitle: 'Do it' }).confirmLabel).toBeNull();
    });

    it('marks the confirm button destructive for an Action declared irreversible, and only for those', () => {
        // The draft delete declares a danger effect that the user is asked about by default.
        expect(presentActionApproval({ actionId: 'session.draft.delete' }).destructive).toBe(true);
        expect(presentActionApproval({ actionId: 'plugins.uninstall' }).destructive).toBe(true);
        // An update asks by policy, but is not declared irreversible.
        expect(presentActionApproval({ actionId: 'updates.batch.start' }).destructive).toBeFalsy();
    });

    it('uses declared irreversibility even when the UI does not ask by default', () => {
        // Explicit irreversibility applies even when the UI does not ask by default.
        expect(presentActionApproval({ actionId: 'session.delete' }).destructive).toBe(true);
        for (const actionId of ['machines.terminal.open', 'session.draft.open', 'discussion.owner.transfer'] as const) {
            expect(presentActionApproval({ actionId }).destructive, actionId).toBeFalsy();
        }
    });

    it('omits a title-only fallback while retaining a distinct authored consequence', async () => {
        for (const language of ['en', 'fr'] as const) {
            await preloadTranslations(language);
            setPreferredLanguageFromSettings(language);
            const spec = getActionSpec('session.draft.delete');
            expect(presentActionApproval({ actionId: spec.id }).summary).toBeNull();
            expect(presentActionApproval({ actionId: spec.id, authoredSummary: buildApprovalPreviewSummary(spec, {}) }).summary).toBeNull();
            expect(presentActionApproval({ actionId: spec.id, authoredSummary: 'A distinct consequence.' }).summary).toBe('A distinct consequence.');
        }
    });

    it('explains the ownership-transfer consequence without exposing transport identities', () => {
        const spec = getActionSpec('discussion.owner.transfer');
        const target = { discussionId: 'opaque-discussion-id', accountId: 'opaque-successor-id' };
        const actionArgs = spec.inputSchema.parse(target);
        const input = { actionId: spec.id, actionArgs };
        const confirmation = presentActionApproval(input);
        expect(confirmation.title).toBe(spec.title);
        expect(confirmation.confirmLabel).toBe(t('approvals.approve'));
        expect(confirmation.summary).toBeTruthy();
        expect(confirmation.summary).not.toBe(`${confirmation.title}.`);
        expect(JSON.stringify(confirmation)).not.toContain(target.discussionId);
        expect(JSON.stringify(confirmation)).not.toContain(target.accountId);
        expect(presentActionApproval({ ...input, authoredSummary: buildApprovalPreviewSummary(spec, actionArgs) }))
            .toEqual(confirmation);
    });
    it('keeps the Personal Home backup clone-authority disclosure in confirmation and Inbox presentation', async () => {
        const spec = getActionSpec('relay.runtime.personal_home.backup');
        const actionArgs = spec.inputSchema.parse({ purpose: { kind: 'personal-home', canonicalServerUrl: 'http://127.0.0.1:43123' } });
        const input = { actionId: spec.id, actionArgs };
        for (const language of ['en', 'fr'] as const) {
            await preloadTranslations(language);
            setPreferredLanguageFromSettings(language);
            const confirmation = presentActionApproval(input);
            const disclosure = t('personalHome.settings.backupDisclosureBody');
            expect(confirmation.summary).toContain(disclosure);
            expect(presentActionApproval({ ...input, authoredSummary: buildApprovalPreviewSummary(spec, actionArgs) }))
                .toEqual(confirmation);
            expect(presentActionApproval({ ...input, authoredSummary: 'Export to your chosen archive.' }).summary)
                .toBe(`Export to your chosen archive.\n\n${disclosure}`);
        }
    });

    it('names the actual Role and its catalog source for override and Reset approvals', () => {
        const roles = buildRoleCatalog({ items: [
            { roleId: 'builder', role: BUILT_IN_ROLES_V1.builder, shared: false, viewOnly: false, migratedFromV0_2: false },
            { roleId: '6780a145-8590-47fa-b294-c5a90aef4041', role: { ...BUILT_IN_ROLES_V1.builder, name: 'Payments reviewer' }, shared: false, viewOnly: false, migratedFromV0_2: false },
            { roleId: 'plugin:acme/reviewer', role: { ...BUILT_IN_ROLES_V1.reviewer, name: 'Security reviewer' }, shared: false, viewOnly: true, migratedFromV0_2: false },
            { roleId: 'shared-role', role: { ...BUILT_IN_ROLES_V1.reviewer, name: 'Team reviewer' }, shared: true, viewOnly: true, migratedFromV0_2: false },
        ], overrides: {} });
        const sourceLabels = { built_in: t('roles.settings.sourceBuiltIn'), user: t('roles.settings.sourceYours'), plugin: t('roles.settings.groupPlugins'), shared: t('roles.settings.sourceShared') };
        for (const role of roles) {
            for (const actionId of ['roles.override.set', 'roles.override.reset'] as const) {
                const presentation = presentActionApproval({ actionId, actionArgs: { roleId: role.roleId }, role });
                expect(presentation.title).toContain(role.role.name);
                expect(presentation.title).toContain(sourceLabels[role.source]);
                expect(presentation.summary).toContain(role.role.name);
                expect(presentation.summary).toContain(sourceLabels[role.source]);
            }
        }
        const role = roles[0]!;
        expect(presentActionApproval({ actionId: 'roles.override.reset', actionArgs: { roleId: 'different' }, role }).title)
            .not.toContain(role.role.name);
    });

    it('reads the canonical typed document reference and localizes both confirmation and request copy', async () => {
        await preloadTranslations('fr');
        setPreferredLanguageFromSettings('fr');
        const spec = getActionSpec('artifact.public_link.create');
        const actionArgs = spec.inputSchema.parse({ artifactId: 'release-notes' });
        expect(readActionApprovalSubject({ actionId: spec.id, actionArgs })).toEqual({ kind: 'artifact', id: 'release-notes' });
        const input = { actionId: spec.id, actionArgs, subject: 'Notes de version' };
        const confirmation = presentActionApproval(input);
        const request = presentActionApproval({ ...input, authoredSummary: buildApprovalPreviewSummary(spec, actionArgs) });
        expect(confirmation).toEqual(request);
        expect(confirmation).toEqual({ title: 'Créer un lien public pour « Notes de version » ?',
            summary: 'Toute personne disposant de ce lien pourra lire le document.',
            confirmLabel: t('approvals.approve') });
        expect(presentActionApproval({ actionId: 'artifact.delete', actionArgs: { artifactId: 'release-notes' } }).title)
            .toBe('Supprimer un document');
        expect(presentActionApproval({ actionId: 'ui.pet.choose', actionArgs: {} }).summary)
            .toBe(t('commandPalette.pets.chooseSubtitle'));
    });

    it('keeps authored plugin titles and summaries, even when they match first-party English copy', async () => {
        await preloadTranslations('fr');
        setPreferredLanguageFromSettings('fr');
        expect(presentActionApproval({ actionId: 'acme.publisher/actions/publish', authoredTitle: 'Create document public link',
            authoredSummary: 'Make a link that lets anyone who has it read a document.' }))
            .toEqual({ title: 'Create document public link', summary: 'Make a link that lets anyone who has it read a document.', confirmLabel: null });
        expect(presentActionApproval({ actionId: 'artifact.public_link.create', authoredSummary: 'My own explanation' }).summary)
            .toBe('My own explanation');
    });
});

    it('leaves the installation question to its review facts without repeating the title in a summary', () => {
        const spec = getActionSpec('machines.managed.bootstrap.respond');
        const actionArgs = spec.inputSchema.parse({ serverId: 'profile', homeId: 'home', managedId: 'managed',
            operationId: 'operation', taskId: 'task', purpose: 'approve', approved: true,
            prompt: { kind: 'ssh.trustHost', message: 'Trust this machine?', host: 'guest.example',
                keyType: 'ssh-ed25519', fingerprint: 'SHA256:guest', existingFingerprint: null } });
        expect(presentActionApproval({ actionId: spec.id, actionArgs }).summary).toBeNull();
    });
