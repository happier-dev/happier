import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMachineFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { installFileFindAccountBoundaryMocks } from '@/components/appShell/panes/fileFindSeedTestHelpers';
import { installUiListsCommonModuleMocks } from '@/components/ui/lists/uiListsTestHelpers';
import { t } from '@/text';
import { formatResetAtTime } from '@/utils/time/formatResetAtTime';

installFileFindAccountBoundaryMocks('home', 'account');
installUiListsCommonModuleMocks();

// Device persistence is a system boundary; retain the real draft repository.
vi.mock('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage', () => {
    const values = new Map<string, string>();
    return { getSessionDraftPersistenceStorage: () => ({
        getString: (key: string) => values.get(key),
        set: (key: string, value: string) => { values.set(key, value); },
        delete: (key: string) => { values.delete(key); },
    }) };
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ params: { draftId: '00000000-0000-4000-8000-000000000081', serverId: 'home' } }).module;
});

// Collect the real screen outside the test timer; cold module loading is not an Open operation.
const { ProjectOpenScreen } = await import('./ProjectOpenScreen');
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');

beforeEach(() => vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 }))));
afterEach(() => { standardCleanup(); vi.unstubAllGlobals(); });

/** A signed-in Home with one online Machine and a retained Open draft for one Source. */
async function seedOpenDraft(draftId: string) {
    const { storage } = await import('@/sync/domains/state/storage');
    const { configureSessionDraftRepository, resetSessionDraftRepositoryForTests, writeProjectOpenDraft, getSessionDraftSnapshot } =
        await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
    resetSessionDraftRepositoryForTests();
    const scope = { serverId: 'home', accountId: 'account' };
    const { createSessionDraftCipher } = await import('@/sync/encryption/sessionDraftEncryption');
    configureSessionDraftRepository({ scope, syncEnabled: false,
        cipher: createSessionDraftCipher({ accountMode: 'plain', accountCryptoMaterial: null,
            getSessionContext: () => { throw new Error('Open has no Session'); }, randomBytes: size => new Uint8Array(size) }) });
    const machine = createMachineFixture({ id: 'machine', activeAt: Date.now() });
    storage.setState({ profileScope: scope, machines: { [machine.id]: machine }, machineListByServerId: { home: [machine] } });
    writeProjectOpenDraft({ scope, draftId, patch: { selection: { serverId: 'home', source: { kind: 'source', id: 'source', revision: 1,
        defaultRef: 'main',
        selector: { provider: { id: 'forge', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
            repository: { nameWithOwner: 'octocat/Hello-World', cloneUrl: 'https://github.com/octocat/Hello-World' }, protocol: 'https' } } } } });
    return { machine, read: () => getSessionDraftSnapshot(scope, { kind: 'projectOpen', draftId })?.document };
}

describe('Project Open rendered choices', () => {
    it('exposes a page header exit that returns to the origin and keeps the draft', async () => {
        const draftId = '00000000-0000-4000-8000-000000000081';
        const seeded = await seedOpenDraft(draftId);
        const { useRouter } = await import('expo-router');
        const router = useRouter();
        vi.mocked(router.back).mockClear();
        const screen = await renderScreen(<ProjectOpenScreen />);
        await vi.waitFor(() => expect(screen.findByTestId('projects.open.choices')).toBeTruthy());
        await act(async () => { screen.findByTestId('projects.open')!.props.onLayout({ nativeEvent: { layout: { width: 390 } } }); });
        expect(screen.findByTestId('projects.open.cancel')).toBeTruthy();
        const before = seeded.read()?.selection.value;
        await act(async () => { screen.pressByTestId('projects.open.cancel'); });
        expect(router.back).toHaveBeenCalledOnce();
        expect(seeded.read()?.selection.value).toEqual(before);
    });

    it.each([{ timed: true, connect: true }, { timed: false, connect: true }, { timed: true, connect: false }])
      ('renders a rate-limit recovery banner (%j)', async ({ timed, connect }) => {
        const draftId = '00000000-0000-4000-8000-000000000081';
        await seedOpenDraft(draftId);
        const { writeProjectOpenDraft } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
        const { AttentionBanner } = await import('@/components/ui/lists/AttentionBanner');
        const screen = await renderScreen(<ProjectOpenScreen />);
        await vi.waitFor(() => expect(screen.findByTestId('projects.open.choices')).toBeTruthy());
        await act(async () => { writeProjectOpenDraft({ scope: { serverId: 'home', accountId: 'account' }, draftId,
            patch: { result: { kind: 'refused', code: 'REMOTE_RATE_LIMITED',
                ...(timed ? { retryNotBeforeMs: 1900000000000 } : {}),
                remediation: { kind: 'retry', ...(connect ? { action: 'connect_github' } : {}) } } } }); });
        const banner = screen.findAllByType(AttentionBanner).find(node => node.props.testID === 'projects.open.refused');
        expect(banner?.props.title).toBe(timed
            ? t('projects.open.githubRateLimitedUntil', { time: formatResetAtTime(1900000000000) })
            : t('projects.open.githubRateLimited'));
        expect(banner?.props.description).toBe(connect ? t('projects.open.githubConnectHint') : undefined);
        expect(banner?.props.details).toContain('REMOTE_RATE_LIMITED');
        expect(banner?.props.action).toBeUndefined();
    });
    it('selects a Machine and renders the named Use group without materializing a checkout', async () => {
        // The platform, router and applied Home are boundaries; the store, draft,
        // controller, chooser and shared radio-group presentation stay real.
        const { storage } = await import('@/sync/domains/state/storage');
        const { configureSessionDraftRepository, resetSessionDraftRepositoryForTests, writeProjectOpenDraft,
            getSessionDraftSnapshot } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
        resetSessionDraftRepositoryForTests();
        const scope = { serverId: 'home', accountId: 'account' };
        const { createSessionDraftCipher } = await import('@/sync/encryption/sessionDraftEncryption');
        configureSessionDraftRepository({ scope, syncEnabled: false,
            cipher: createSessionDraftCipher({ accountMode: 'plain', accountCryptoMaterial: null,
                getSessionContext: () => { throw new Error('Open has no Session'); }, randomBytes: size => new Uint8Array(size) }) });
        const machine = createMachineFixture({ id: 'machine', activeAt: Date.now() });
        storage.setState({ profileScope: scope, machines: { [machine.id]: machine }, machineListByServerId: { home: [machine] } });
        const draftId = '00000000-0000-4000-8000-000000000081';
        writeProjectOpenDraft({ scope, draftId, patch: { selection: { serverId: 'home', source: { kind: 'source', id: 'source', revision: 1,
            selector: { provider: { id: 'forge', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                repository: { nameWithOwner: 'octocat/Hello-World', cloneUrl: 'https://github.com/octocat/Hello-World' }, protocol: 'https' } } } } });
        const screen = await renderScreen(<ProjectOpenScreen />);
        const picker = () => screen.findAllByType(DropdownMenu).find(node =>
            node.props.items.some((item: { id: string }) => item.id === machine.id));
        await vi.waitFor(() => expect(picker()).toBeDefined());
        const machinePicker = picker();
        expect(machinePicker).toBeDefined();
        await act(async () => { machinePicker!.props.onSelect(machine.id); });
        // One reachable way to open is a statement, not a one-option radio group (T1-F15).
        expect(screen.findAllByType('View' as never).find(node => node.props.role === 'radiogroup')).toBeUndefined();
        expect(screen.findByTestId('projects.open.use.clone')).toBeTruthy();
        expect(getSessionDraftSnapshot(scope, { kind: 'projectOpen', draftId })?.document)
            .toMatchObject({ selection: { value: { machineId: 'machine' } } });
        await act(async () => { writeProjectOpenDraft({ scope, draftId, patch: { result: { kind: 'outcomeUnknown' } } }); });
        const { AttentionBanner } = await import('@/components/ui/lists/AttentionBanner');
        const unknown = screen.findAllByType(AttentionBanner).find(node => node.props.testID === 'projects.open.unknown');
        expect(unknown).toBeDefined();
        // Without an original handle, neither navigation nor a fresh clone is a Check.
        expect(unknown?.props.action).toBeUndefined();
        expect(unknown?.props.secondaryAction).toBeUndefined();
        await act(async () => { writeProjectOpenDraft({ scope, draftId, patch: {
            uncertainInputs: [{ serverId: 'home', machineId: machine.id, source: { kind: 'folder', path: '/repo' }, materialization: { kind: 'attach' } }],
            result: { kind: 'outcomeUnknown', operationId: 'original-attempt' },
        } }); });
        const checkable = screen.findAllByType(AttentionBanner).find(node => node.props.testID === 'projects.open.unknown');
        expect(checkable?.props.action).toMatchObject({ onPress: expect.any(Function) });
        expect(checkable?.props.secondaryAction).toBeUndefined();
    });
    it('names the Machine once with its status and a quiet Change, and starts the only clone at a home-relative suggestion', async () => {
        const draftId = '00000000-0000-4000-8000-000000000081';
        const seeded = await seedOpenDraft(draftId);
        const { ProjectOpenScreen } = await import('./ProjectOpenScreen');
        const { Item } = await import('@/components/ui/lists/Item');
        const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
        const screen = await renderScreen(<ProjectOpenScreen />);
        const where = () => screen.findAllByType(DropdownMenu).find(node => node.props.testID === 'projects.open.where');
        await vi.waitFor(() => expect(where()).toBeDefined());
        await act(async () => { where()!.props.onSelect(seeded.machine.id); });
        const name = screen.findAllByType(Item).find(node => node.props.testID === 'projects.open.where.row')!.props.title;
        // The name is the row's title and nowhere else beside it: no value field repeats it (T1-F9).
        expect(screen.findAllByType(Item).filter(node => node.props.title === name)).toHaveLength(1);
        expect(screen.findByTestId('projects.open.where.change')).toBeTruthy();
        // Selecting the Machine left one way to open: the clone, into the suggested folder (T1-F5/F15).
        expect(seeded.read()).toMatchObject({ selection: { value: { machineId: 'machine', materialization: {
            kind: 'clone', destinationParentPath: '/Users/tester/src', destinationDirectoryName: 'Hello-World' } } } });
        const clone = screen.findAllByType(Item).find(node => node.props.testID === 'projects.open.use.clone')!;
        expect(clone.props.accessibilityRole).toBeUndefined();
        // The destination is said once, in the option; the standalone Folder field is gone until Change.
        expect(screen.findByTestId('projects.open.destination')).toBeFalsy();
        await act(async () => { screen.pressByTestId('projects.open.destination.change'); });
        expect(screen.findByTestId('projects.open.destination')).toBeTruthy();
    });

    it('chooses the branch from a field select whose Other entry asks for any ref', async () => {
        const draftId = '00000000-0000-4000-8000-000000000081';
        const seeded = await seedOpenDraft(draftId);
        const { ProjectOpenScreen } = await import('./ProjectOpenScreen');
        const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
        const { Modal } = await import('@/modal');
        const screen = await renderScreen(<ProjectOpenScreen />);
        const branch = () => screen.findAllByType(DropdownMenu).find(node => node.props.testID === 'projects.open.subject.ref');
        await vi.waitFor(() => expect(branch()).toBeDefined());
        expect(branch()!.props.items.map((item: { id: string }) => item.id)).toEqual(['ref:@default', 'ref:@other']);
        expect(branch()!.props.selectedId).toBe('ref:@default');
        vi.mocked(Modal.prompt).mockResolvedValueOnce(' release/0.4 ');
        await act(async () => { branch()!.props.onSelect('ref:@other'); });
        await vi.waitFor(() => expect(seeded.read()).toMatchObject({ selection: { value: { ref: 'release/0.4' } } }));
        expect(branch()!.props.selectedId).toBe('ref:release/0.4');
    });

    it('hosted as the desktop dialog, puts its footer in the card slot and keeps the draft address its own', async () => {
        const draftId = '00000000-0000-4000-8000-000000000081';
        await seedOpenDraft(draftId);
        const { ProjectOpenScreen } = await import('./ProjectOpenScreen');
        const { PageHeader } = await import('@/components/ui/layout/PageHeader');
        const setChrome = vi.fn();
        const screen = await renderScreen(<ProjectOpenScreen routeParams={{ draftId, serverId: 'home' }} setChrome={setChrome} onClose={() => {}} />);
        await vi.waitFor(() => expect(screen.findByTestId('projects.open.choices')).toBeTruthy());
        // The card header carries the title; the body has no page header and no footer of its own.
        expect(screen.findAllByType(PageHeader)).toHaveLength(0);
        expect(screen.findByTestId('projects.open.submit')).toBeFalsy();
        expect(setChrome).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'card', footer: expect.anything() }));
    });
});
