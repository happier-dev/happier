import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { SELECTION_LIST_DEFAULT_DYNAMIC_DEBOUNCE_MS } from '@/components/ui/selectionList/_constants';
import { SessionAccessEditor } from './SessionAccessEditor';
import type { SessionAccessCandidateRowModel, SessionAccessEditorActions, SessionAccessEditorModel, SessionAccessGrantRowModel } from './sessionAccessEditorTypes';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
// The virtualized list is a third-party rendering boundary; the testkit owns it.
vi.mock('@legendapp/list/react-native', async () => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit');
    return { LegendList: createCapturingLegendListMock({ renderItems: true, renderItemLimit: 20 }).module.LegendList };
});
// The platform screen-reader live region is a genuine OS/DOM boundary.
// The platform clipboard is an OS boundary.
const clipboard = vi.hoisted(() => ({ written: [] as string[] }));
vi.mock('expo-clipboard', () => ({ setStringAsync: async (value: string) => { clipboard.written.push(value); } }));
const announceAccessibilityMessage = vi.fn();
vi.mock('@/components/ui/accessibility/announceAccessibilityMessage', () => ({
    announceAccessibilityMessage: (message: string) => announceAccessibilityMessage(message),
}));

const alice: SessionAccessGrantRowModel = {
    grant: { kind: 'account', accountId: 'alice' },
    principal: { ref: { kind: 'account', accountId: 'alice' }, key: 'account:alice', displayName: 'Alice', accessibilityLabel: 'Alice, Account' },
    level: { kind: 'editable', value: 'edit', options: ['view', 'edit'] },
    permissionDelegation: { kind: 'editable', value: true },
    removal: { kind: 'allowed' },
    requiredByTeamPolicy: false,
    operation: { kind: 'idle' },
};
const team: SessionAccessGrantRowModel = {
    ...alice,
    grant: { kind: 'team', teamId: 'acme' },
    principal: { ref: { kind: 'team', teamId: 'acme' }, key: 'team:acme', displayName: 'Acme', accessibilityLabel: 'Acme, Team' },
    level: { kind: 'locked', value: 'view', reason: { code: 'required_by_team_policy', message: 'Team policy requires this access.' } },
    permissionDelegation: { kind: 'hidden' },
    removal: { kind: 'blocked', reason: { code: 'required_by_team_policy', message: 'Team policy requires this access.' } },
    requiredByTeamPolicy: true,
};
function model(overrides: Partial<SessionAccessEditorModel> = {}): SessionAccessEditorModel {
    return {
        revision: 1, accessMode: 'editable', content: { phase: 'ready', hasLastAcknowledgedSnapshot: true }, owner: null,
        grants: [alice, team], directory: { query: 'unrelated search', sections: [] },
        summary: { label: 'Custom access', accessibilityLabel: 'Session access', requiredByTeamPolicy: true }, ...overrides,
    };
}
function actions(): SessionAccessEditorActions {
    return { setQuery: vi.fn(), retryContent: vi.fn(), retryDirectory: vi.fn(), loadMore: vi.fn(), addPrincipal: vi.fn(), retryMutation: vi.fn(), setAccessLevel: vi.fn(), setPermissionDelegation: vi.fn(), requestRemove: vi.fn(), confirmRemove: vi.fn(), cancelRemove: vi.fn(), explain: vi.fn(), setContext: vi.fn(), confirmContext: vi.fn(), cancelContext: vi.fn(), clearAccess: vi.fn(), prepareAccess: vi.fn(), toggleAllRecipients: vi.fn(), loadMoreRecipients: vi.fn() };
}
/** The status row the list builds for `model.content.issue`, addressed by its canonical option id. */
const ISSUE_ROW_TEST_ID = 'session-access-editor:list:session-access:option:issue';

describe('SessionAccessEditor', () => {
    beforeEach(() => announceAccessibilityMessage.mockClear());
    afterEach(() => vi.useRealTimers());
    it('adds different principal kinds without closing and preserves source-ranked results', async () => {
        vi.useFakeTimers();
        const intent = actions();
        const close = vi.fn();
        const candidate = (kind: 'account' | 'group'): SessionAccessCandidateRowModel => ({
            principal: kind === 'account'
                ? { ref: { kind, accountId: 'bob' }, key: 'account:bob', displayName: 'Same name', accessibilityLabel: 'Bob, Account' }
                : { ref: { kind, teamId: 'acme', groupId: 'dev' }, key: 'group:acme:dev', displayName: 'Same name', accessibilityLabel: 'Developers, Acme Group' },
            addition: { kind: 'allowed' }, operation: { kind: 'idle' },
        });
        const people = candidate('account');
        const group = candidate('group');
        const directory = { query: 'provider-ranked-query', sections: ([people, group]).map((row) => ({
            kind: row.principal.ref.kind, title: row.principal.ref.kind, candidates: [row], status: 'idle' as const,
            cursor: null, hasMore: false, loadingMore: false,
            resolverKey: `home-one:${row.principal.ref.kind}`, resolveCandidates: async () => [row],
        })) };
        const screen = await renderScreen(<SessionAccessEditor model={model({ directory })} actions={intent} presentation="full" onRequestClose={close} />);
        await flushHookEffects({ advanceTimersMs: SELECTION_LIST_DEFAULT_DYNAMIC_DEBOUNCE_MS });
        expect(screen.findByTestId('session-access-candidate-account:bob')).not.toBeNull();
        await screen.pressByTestIdAsync('session-access-candidate-account:bob');
        await screen.pressByTestIdAsync('session-access-browse:group');
        await flushHookEffects({ advanceTimersMs: SELECTION_LIST_DEFAULT_DYNAMIC_DEBOUNCE_MS });
        await screen.pressByTestIdAsync('session-access-candidate-group:acme:dev');
        expect(intent.addPrincipal).toHaveBeenNthCalledWith(1, people.principal.ref);
        expect(intent.addPrincipal).toHaveBeenNthCalledWith(2, group.principal.ref);
        expect(close).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync('session-access-editor:list:header:leading:back-chip');
        expect(screen.findByTestId('session-access-grant-account:alice')).not.toBeNull();
    });
    it('offers level choices in one order whatever order the Home returned them in', async () => {
        const unordered = { ...alice, level: { kind: 'editable' as const, value: 'edit' as const, options: ['admin', 'view', 'edit'] as const } };
        const screen = await renderScreen(<SessionAccessEditor model={model({ grants: [unordered] })} actions={actions()} presentation="full" />);
        await screen.pressByTestIdAsync('session-access-grant-account:alice');
        const rendered = [...new Set(screen.findAll((node) => typeof node.type === 'string' && typeof node.props.testID === 'string'
            && node.props.testID.startsWith('session-access-level:account:alice:')).map((node) => node.props.testID as string))];
        expect(rendered).toEqual(['session-access-level:account:alice:view', 'session-access-level:account:alice:edit',
            'session-access-level:account:alice:admin']);
    });
    it('copies the Session link the host supplies and offers nothing to copy without one', async () => {
        clipboard.written = [];
        const screen = await renderScreen(<SessionAccessEditor model={model()} actions={actions()} presentation="full" linkPath="/session/s-1" />);
        await screen.pressByTestIdAsync('session-access-copy-link');
        await flushHookEffects();
        expect(clipboard.written).toHaveLength(1);
        expect(clipboard.written[0]!.endsWith('/session/s-1')).toBe(true);
        await screen.update(<SessionAccessEditor model={model()} actions={actions()} presentation="full" />);
        expect(screen.findByTestId('session-access-copy-link')).toBeNull();
    });
    it('offers a row-local retry for an outcome-unknown mutation and preserves its subject', async () => {
        const intent = actions();
        const failed = { ...alice, operation: { kind: 'error' as const, error: { code: 'outcome_unknown', message: 'Could not confirm the change.', retryable: true } } };
        const screen = await renderScreen(<SessionAccessEditor model={model({ grants: [failed] })} actions={intent} presentation="full" />);

        await screen.pressByTestIdAsync('session-access-grant-account:alice');
        await screen.pressByTestIdAsync('session-access-retry:account:alice');

        expect(intent.retryMutation).toHaveBeenCalledWith(failed.grant);
    });
    it.each(['compact', 'full'] as const)('renders the same truthful inspection-only access projection in %s', async (presentation) => {
        const screen = await renderScreen(<SessionAccessEditor model={model({
            accessMode: 'read_only',
            grants: [],
            viewerAccess: {
                level: 'edit',
                levelLabel: 'Edit',
                sourceLabels: ['Team access'],
                accessibilityLabel: 'Your access: Edit. Team access',
            },
        })} actions={actions()} presentation={presentation} />);

        const row = screen.findByTestId('session-access-viewer-access');
        expect(row).not.toBeNull();
        const text = screen.getTextContent();
        // The shared list primitive owns section-title casing, so the contract
        // here is the projected content, not how ItemGroup renders its heading.
        expect(text.toLowerCase()).toContain('your access');
        expect(text).toContain('Edit');
        expect(text).toContain('Team access');
        // Self access is a truthful summary, never the manager-only roster.
        expect(text).not.toContain('Alice');
    });
    it('pages only the browsed directory through the canonical list footer', async () => {
        vi.useFakeTimers();
        const intent = actions();
        const directory = { query: 'acme', sections: [{
            kind: 'group' as const, title: 'Groups', candidates: [], status: 'idle' as const,
            cursor: 'group-page-two', hasMore: true, loadingMore: false,
        }] };
        const screen = await renderScreen(<SessionAccessEditor model={model({ directory })} actions={intent} presentation="full" />);
        await screen.pressByTestIdAsync('session-access-browse:group');
        await flushHookEffects({ advanceTimersMs: SELECTION_LIST_DEFAULT_DYNAMIC_DEBOUNCE_MS });
        await screen.pressByTestIdAsync('session-access-editor:list:pagination:more');
        expect(intent.loadMore).toHaveBeenCalledWith('group');
        expect(intent.addPrincipal).not.toHaveBeenCalled();
        await screen.update(<SessionAccessEditor model={model({ revision: 2, directory: { ...directory, sections: [{ ...directory.sections[0], loadingMore: true }] } })} actions={intent} presentation="full" />);
        expect(screen.findByTestId('session-access-editor:list:pagination:loading')).not.toBeNull();
    });
    it('routes a failed directory footer through the directory retry owner', async () => {
        vi.useFakeTimers();
        const intent = actions();
        const directory = { query: '', sections: [{
            kind: 'group' as const, title: 'Groups', candidates: [], status: 'error' as const,
            error: { code: 'session_access_directory_failed', message: 'Unavailable', retryable: true },
            cursor: 'group-retry', hasMore: true, loadingMore: false,
        }] };
        const screen = await renderScreen(<SessionAccessEditor model={model({ directory })} actions={intent} presentation="full" />);
        await screen.pressByTestIdAsync('session-access-browse:group');
        await flushHookEffects({ advanceTimersMs: SELECTION_LIST_DEFAULT_DYNAMIC_DEBOUNCE_MS });
        await screen.pressByTestIdAsync('session-access-editor:list:pagination:retry');
        expect(intent.retryDirectory).toHaveBeenCalledWith('group');
        expect(intent.loadMore).not.toHaveBeenCalled();
    });
    it.each(['compact', 'full'] as const)('keeps acknowledged principals during search and failed refresh in %s', async (presentation) => {
        const intent = actions();
        const issue = { code: 'unavailable', message: 'Unavailable', retryable: true };
        const screen = await renderScreen(<SessionAccessEditor model={model({ content: { phase: 'error', hasLastAcknowledgedSnapshot: true, issue } })} actions={intent} presentation={presentation} />);
        expect(screen.findByTestId('session-access-grant-account:alice')).not.toBeNull();
        expect(screen.findByTestId('session-access-grant-team:acme')).not.toBeNull();
        expect(screen.findByTestId('session-access-editor:list:body')?.props.role).toBe('grid');

        // The recovery is the canonical refresh, and it is reachable rather than
        // decorative; a settled failure offers no retry that cannot succeed.
        await screen.pressByTestIdAsync(ISSUE_ROW_TEST_ID);
        expect(intent.retryContent).toHaveBeenCalledTimes(1);

        await screen.update(<SessionAccessEditor model={model({ revision: 2, content: { phase: 'error', hasLastAcknowledgedSnapshot: true, issue: { ...issue, retryable: false } } })} actions={intent} presentation={presentation} />);
        await screen.pressByTestIdAsync(ISSUE_ROW_TEST_ID);
        expect(intent.retryContent).toHaveBeenCalledTimes(1);
    });
    it('changes only the selected principal and keeps removal as two explicit intents', async () => {
        const intent = actions();
        const screen = await renderScreen(<SessionAccessEditor model={model()} actions={intent} presentation="compact" />);
        await screen.pressByTestIdAsync('session-access-grant-account:alice');
        await screen.pressByTestIdAsync('session-access-level:account:alice:view');
        expect(intent.setAccessLevel).toHaveBeenCalledWith(alice.grant, 'view');
        expect(intent.setPermissionDelegation).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync('session-access-remove:account:alice');
        expect(intent.requestRemove).toHaveBeenCalledWith(alice.grant);
        expect(intent.confirmRemove).not.toHaveBeenCalled();
        await screen.update(<SessionAccessEditor model={model({ revision: 2, grants: [{ ...alice, removal: { kind: 'confirming', consequences: [] } }, team] })} actions={intent} presentation="compact" />);
        await screen.pressByTestIdAsync('session-access-remove-confirm:account:alice');
        expect(intent.confirmRemove).toHaveBeenCalledWith(alice.grant);
    });
    it('offers the anchored composer editor a route into the full Collaboration surface', async () => {
        const intent = actions();
        const openFullSurface = vi.fn();
        const screen = await renderScreen(
            <SessionAccessEditor model={model()} actions={intent} presentation="compact" onOpenFullSurface={openFullSurface} />,
        );
        await screen.pressByTestIdAsync('session-access-open-collaboration');
        expect(openFullSurface).toHaveBeenCalledTimes(1);
        // The destination mounts its own controller, so what the person already
        // typed here is the one thing the handoff has to carry.
        expect(openFullSurface).toHaveBeenLastCalledWith({ query: 'unrelated search' });
        // The full surface is already the Collaboration destination, so it must
        // never offer to open itself.
        await screen.update(<SessionAccessEditor model={model({ revision: 2 })} actions={intent} presentation="full" />);
        expect(screen.findByTestId('session-access-open-collaboration')).toBeNull();
    });
    it('tags the person who is responsible for the Session in the access list', async () => {
        const screen = await renderScreen(<SessionAccessEditor model={model()} actions={actions()} presentation="full" responsibleAccountId="alice" />);
        expect(screen.getTextContent()).toContain('Responsible');
        await screen.update(<SessionAccessEditor model={model()} actions={actions()} presentation="full" responsibleAccountId={null} />);
        expect(screen.getTextContent()).not.toContain('Responsible');
    });
    it('explains a policy lock and exposes no read-only mutations', async () => {
        const intent = actions();
        const screen = await renderScreen(<SessionAccessEditor model={model()} actions={intent} presentation="full" />);
        await screen.pressByTestIdAsync('session-access-level:team:acme');
        expect(intent.explain).toHaveBeenCalledWith(team.level.kind === 'locked' ? team.level.reason : undefined);
        expect(intent.requestRemove).not.toHaveBeenCalled();
        await screen.update(<SessionAccessEditor model={model({ accessMode: 'read_only' })} actions={intent} presentation="full" />);
        await screen.pressByTestIdAsync('session-access-grant-account:alice');
        expect(screen.findByTestId('session-access-level:account:alice:view')).toBeNull();
        expect(screen.findByTestId('session-access-remove:account:alice')).toBeNull();
    });
    it('renders a pending approval where it is decided and holds every other edit until it settles', async () => {
        const intent = { ...actions(), openPendingApproval: vi.fn() };
        const screen = await renderScreen(<SessionAccessEditor model={model({
            pendingApproval: { artifactId: 'approval-1', serverId: 'home-one' },
        })} actions={intent} presentation="full" />);
        await screen.pressByTestIdAsync('session-access-approval');
        expect(intent.openPendingApproval).toHaveBeenCalledTimes(1);
        await screen.pressByTestIdAsync('session-access-grant-account:alice');
        expect(screen.findByTestId('session-access-level:account:alice:view')).toBeNull();
        expect(screen.findByTestId('session-access-remove:account:alice')).toBeNull();
    });
    it('offers the owner of a historical Session an explicit update for sharing', async () => {
        const intent = { ...actions(), updateHistoricalLayout: vi.fn() };
        const screen = await renderScreen(<SessionAccessEditor model={model({
            historicalLayout: { updating: false },
        })} actions={intent} presentation="full" />);
        await screen.pressByTestIdAsync('session-access-historical-layout-update');
        expect(intent.updateHistoricalLayout).toHaveBeenCalledTimes(1);
    });
    it('keeps a required primary-Team context non-removable while still showing other Team choices', async () => {
        const intent = actions();
        const screen = await renderScreen(<SessionAccessEditor model={model({ context: {
            primaryTeamId: 'acme',
            options: [
                { teamId: null, label: 'Private', blockedReason: { code: 'session_access_team_policy_required', message: 'Required by Team policy' } },
                { teamId: 'acme', label: 'Acme' },
                { teamId: 'design', label: 'Design' },
            ],
        } })} actions={intent} presentation="full" />);
        expect(screen.findByTestId('session-access-context-personal')).toBeNull();
        await screen.pressByTestIdAsync('session-access-context');
        await screen.pressByTestIdAsync('session-access-context-personal');
        expect(intent.setContext).not.toHaveBeenCalled();
        expect(intent.explain).toHaveBeenCalledWith(expect.objectContaining({ code: 'session_access_team_policy_required' }));
        await screen.pressByTestIdAsync('session-access-context-design');
        expect(intent.setContext).toHaveBeenCalledWith('design');
    });
    it('renders context consequences and requires an explicit confirmation', async () => {
        const intent = actions();
        const screen = await renderScreen(<SessionAccessEditor model={model({ context: {
            primaryTeamId: null,
            options: [{ teamId: null, label: 'Private' }, { teamId: 'acme', label: 'Acme' }],
            confirmation: {
                teamId: 'acme',
                label: 'Acme',
                consequences: ['Adds the Team policy access floor.', 'External sharing is disabled for this Team.'],
            },
        } })} actions={intent} presentation="full" />);
        expect(screen.findByTestId('session-access-editor:list:session-access:option:context-consequence:0')).not.toBeNull();
        expect(screen.findByTestId('session-access-editor:list:session-access:option:context-consequence:1')).not.toBeNull();
        await screen.pressByTestIdAsync('session-access-context-confirm');
        expect(intent.confirmContext).toHaveBeenCalledTimes(1);
        await screen.pressByTestIdAsync('session-access-context-cancel');
        expect(intent.cancelContext).toHaveBeenCalledTimes(1);
    });
    it('keeps the reviewed target visibly busy and prevents duplicate confirmation while saving', async () => {
        const intent = actions();
        const screen = await renderScreen(<SessionAccessEditor model={model({ context: {
            primaryTeamId: null,
            options: [{ teamId: null, label: 'Private' }, { teamId: 'acme', label: 'Acme' }],
            operation: 'saving',
            confirmation: {
                teamId: 'acme',
                label: 'Acme',
                consequences: ['Adds the Team policy access floor.'],
            },
        } })} actions={intent} presentation="compact" />);

        await screen.pressByTestIdAsync('session-access-context');

        expect(screen.findByTestId('session-access-context-acme')?.props.accessibilityState)
            .toEqual(expect.objectContaining({ disabled: true, busy: true }));
        expect(screen.findByTestId('session-access-context-confirm')?.props.accessibilityState)
            .toEqual(expect.objectContaining({ disabled: true }));
        expect(screen.findByTestId('session-access-context-cancel')?.props.accessibilityState)
            .toEqual(expect.objectContaining({ disabled: true }));
    });
    it('keeps a blocked creation draft recoverable through the mounted editor', async () => {
        const intent = actions();
        const screen = await renderScreen(<SessionAccessEditor
            model={model({ accessMode: 'read_only', notice: { message: 'Choose Private to continue.', action: 'clear_access' } })}
            actions={intent}
            presentation="compact"
        />);
        await screen.pressByTestIdAsync('session-access-clear-draft');
        expect(intent.clearAccess).toHaveBeenCalledTimes(1);
    });
    it('exposes the Session aggregate, its preparation action, and the explicit all-people view', async () => {
        const intent = actions();
        const screen = await renderScreen(<SessionAccessEditor
            model={model({ encryption: {
                statusKey: 'needs_attention',
                summaryLabel: '4 prepared · 2 pending',
                accessibilityLabel: 'Encrypted access: 4 prepared · 2 pending',
                actionLabel: 'Prepare now',
                showAllLabel: 'Show all people',
                recipientsView: 'exceptions',
            } })}
            actions={intent}
            presentation="full"
        />);
        expect(screen.findByTestId('session-access-encryption-summary')).toBeTruthy();
        await screen.pressByTestIdAsync('session-access-prepare');
        await screen.pressByTestIdAsync('session-access-show-all-recipients');
        expect(intent.prepareAccess).toHaveBeenCalledTimes(1);
        expect(intent.toggleAllRecipients).toHaveBeenCalledTimes(1);
    });

    it('attaches a known direct recipient state to its grant with one preparation control', async () => {
        const intent = actions();
        const screen = await renderScreen(<SessionAccessEditor model={model({ encryption: {
            statusKey: 'needs_attention', summaryLabel: '1 pending', accessibilityLabel: 'Encrypted access: 1 pending',
            actionLabel: 'Prepare now', showAllLabel: 'Show all people', recipientsView: 'exceptions',
            recipients: { rows: [{ recipientAccountId: 'alice', state: 'pending', label: 'Alice',
                stateLabel: 'Encrypted access pending', accessibilityLabel: 'Alice: Encrypted access pending', actionLabel: 'Prepare now' }],
                hasMore: false, loading: false },
        } })} actions={intent} presentation="full" />);
        expect(screen.findByTestId('session-access-recipient-alice')).toBeNull();
        expect(screen.findByTestId('session-access-prepare')).toBeNull();
        const grant = screen.findByTestId('session-access-grant-account:alice');
        expect(grant).not.toBeNull();
        expect(screen.getTextContent()).toContain('Encrypted access pending');
        await screen.pressByTestIdAsync('session-access-grant-account:alice');
        await screen.pressByTestIdAsync('session-access-reprepare-alice');
        expect(intent.prepareAccess).toHaveBeenCalledWith('alice');
        await screen.pressByTestIdAsync('session-access-show-all-recipients');
        expect(intent.toggleAllRecipients).toHaveBeenCalledTimes(1);
    });

    it.each([
        { audience: 'a Team recipient with no direct grant', grants: [team], hasMore: false, directGrant: false },
        { audience: 'a partial recipient page', grants: [alice], hasMore: true, directGrant: true },
    ])('keeps audience preparation reachable for $audience while its diagnostic is folded', async ({ grants, hasMore, directGrant }) => {
        const intent = actions();
        const accessModel = model({ grants, encryption: {
            statusKey: 'needs_attention', summaryLabel: '1 pending', accessibilityLabel: 'Encrypted access: 1 pending',
            actionLabel: 'Prepare now', showAllLabel: 'Show all people', recipientsView: 'exceptions',
            recipients: { rows: [{ recipientAccountId: 'alice', state: 'pending', label: 'Alice',
                stateLabel: 'Encrypted access pending', accessibilityLabel: 'Alice: Encrypted access pending', actionLabel: 'Prepare now' }],
                hasMore, loading: false },
        } });
        const screen = await renderScreen(<SessionAccessEditor model={accessModel} actions={intent} presentation="full" />);
        expect(screen.findByTestId('session-access-recipient-alice')).toBeNull();
        await screen.pressByTestIdAsync('session-access-prepare');
        expect(intent.prepareAccess).toHaveBeenCalledWith();
        expect(screen.findByTestId('session-access-reprepare-alice')).toBeNull();
        await screen.pressByTestIdAsync('session-access-show-all-recipients');
        expect(intent.toggleAllRecipients).toHaveBeenCalledTimes(1);
        await screen.update(<SessionAccessEditor model={{ ...accessModel,
            encryption: { ...accessModel.encryption!, recipientsView: 'all', showAllLabel: 'Hide people' } }}
            actions={intent} presentation="full" />);
        expect(screen.findByTestId('session-access-recipient-alice')).not.toBeNull();
        expect(screen.findByTestId('session-access-grant-account:alice') !== null).toBe(directGrant);
    });

    it('announces the material preparation transitions and stays silent through progress', async () => {
        const intent = actions();
        const preparing = (preparedCount: number) => model({ encryption: {
            statusKey: 'preparing' as const,
            summaryLabel: 'Preparing encrypted access…',
            accessibilityLabel: `Preparing encrypted access… ${preparedCount} of 3`,
            progressLabel: `Preparing encrypted access… ${preparedCount} of 3`,
            showAllLabel: 'Show all people',
            recipientsView: 'exceptions' as const,
        } });
        const screen = await renderScreen(<SessionAccessEditor
            model={preparing(1)} actions={intent} presentation="full" />);
        expect(announceAccessibilityMessage).not.toHaveBeenCalled();

        // Committed-count ticks are not a transition.
        await screen.update(<SessionAccessEditor model={preparing(2)} actions={intent} presentation="full" />);
        expect(announceAccessibilityMessage).not.toHaveBeenCalled();

        await screen.update(<SessionAccessEditor model={model({ encryption: {
            statusKey: 'ready',
            summaryLabel: 'Encrypted access prepared',
            accessibilityLabel: 'Encrypted access prepared',
            announcement: 'Encrypted access preparation complete.',
            showAllLabel: 'Show all people',
            recipientsView: 'exceptions',
        } })} actions={intent} presentation="full" />);
        expect(announceAccessibilityMessage).toHaveBeenCalledTimes(1);
        expect(announceAccessibilityMessage).toHaveBeenCalledWith('Encrypted access preparation complete.');

        // A later page of the same settled state announces nothing more.
        await screen.update(<SessionAccessEditor model={model({ encryption: {
            statusKey: 'ready',
            summaryLabel: 'Encrypted access prepared',
            accessibilityLabel: 'Encrypted access prepared',
            announcement: 'Encrypted access preparation complete.',
            showAllLabel: 'Hide people',
            recipientsView: 'all',
            recipients: { rows: [], hasMore: false, loading: false },
        } })} actions={intent} presentation="full" />);
        expect(announceAccessibilityMessage).toHaveBeenCalledTimes(1);
    });

    it('pages the diagnostic and lets a manager reprepare structurally prepared recipients', async () => {
        const intent = actions();
        const screen = await renderScreen(<SessionAccessEditor
            model={model({ encryption: {
                statusKey: 'needs_attention',
                summaryLabel: '4 prepared · 2 pending',
                accessibilityLabel: 'Encrypted access: 4 prepared · 2 pending',
                showAllLabel: 'Hide people',
                recipientsView: 'all',
                recipients: {
                    rows: [{
                        recipientAccountId: 'account-pending', state: 'pending',
                        label: 'Ada Lovelace', stateLabel: 'Encrypted access pending',
                        accessibilityLabel: 'Ada Lovelace: Encrypted access pending',
                        actionLabel: 'Prepare now',
                    }, {
                        recipientAccountId: 'account-ready', state: 'prepared',
                        label: 'Grace Hopper', stateLabel: 'Encrypted access prepared',
                        accessibilityLabel: 'Grace Hopper: Encrypted access prepared',
                    }],
                    hasMore: true,
                    loading: false,
                },
            } })}
            actions={intent}
            presentation="full"
        />);
        expect(screen.findByTestId('session-access-recipient-account-pending')).toBeTruthy();
        // The row model decides the affordance: this fixture gives the delivered row none.
        await screen.pressByTestIdAsync('session-access-reprepare-account-pending');
        expect(intent.prepareAccess).toHaveBeenCalledWith('account-pending');
        expect(screen.findByTestId('session-access-reprepare-account-ready')).toBeNull();
        await screen.pressByTestIdAsync('session-access-recipients-more');
        expect(intent.loadMoreRecipients).toHaveBeenCalledTimes(1);
    });

    it('marks a retained roster stale while the Home is unreachable instead of reading as current', async () => {
        const screen = await renderScreen(<SessionAccessEditor
            model={model({ content: {
                phase: 'error',
                hasLastAcknowledgedSnapshot: true,
                issue: { code: 'session_access_failed', message: 'Something went wrong', retryable: true },
            } })}
            actions={actions()}
            presentation="full"
        />);

        // Last-good rows stay (never an authoritative empty roster), but they must not
        // read as the current answer — the same de-emphasis presence already uses.
        expect(screen.findByTestId('session-access-grant-account:alice')).toBeTruthy();
        // The shared list primitive owns section-title casing, so the contract is the
        // projected content, not how ItemGroup renders its heading.
        expect(screen.getTextContent().toLowerCase()).toContain('may be out of date');
    });

    it('gives every principal row its identity visual without adding a second accessible name', async () => {
        vi.useFakeTimers();
        const aliceWithAvatar: SessionAccessGrantRowModel = {
            ...alice,
            principal: { ...alice.principal, avatar: { id: 'alice', imageUrl: 'https://cdn.example/alice.png' } },
        };
        const candidate: SessionAccessCandidateRowModel = {
            principal: { ref: { kind: 'group', teamId: 'acme', groupId: 'dev' }, key: 'group:acme:dev',
                displayName: 'Developers', accessibilityLabel: 'Developers, Acme Group' },
            addition: { kind: 'allowed' }, operation: { kind: 'idle' },
        };
        const directory = { query: '', sections: [{
            kind: 'group' as const, title: 'Groups', candidates: [candidate], status: 'idle' as const,
            cursor: null, hasMore: false, loadingMore: false,
            resolverKey: 'home-one:group', resolveCandidates: async () => [candidate],
        }] };
        const screen = await renderScreen(<SessionAccessEditor model={model({
            owner: { principal: { ref: { kind: 'account', accountId: 'owner' }, key: 'account:owner',
                displayName: 'Owner', accessibilityLabel: 'Owner, Account', avatar: { id: 'owner' } } },
            grants: [aliceWithAvatar, team], directory,
        })} actions={actions()} presentation="full" />);
        await flushHookEffects({ advanceTimersMs: SELECTION_LIST_DEFAULT_DYNAMIC_DEBOUNCE_MS });

        for (const key of ['account:owner', 'account:alice', 'team:acme']) {
            const visual = screen.findByTestId(`session-access-principal-visual:${key}`);
            expect(visual).not.toBeNull();
            // The row's own accessibilityLabel stays the single accessible name.
            expect(visual?.props.accessibilityElementsHidden).toBe(true);
        }
        await screen.pressByTestIdAsync('session-access-browse:group');
        await flushHookEffects({ advanceTimersMs: SELECTION_LIST_DEFAULT_DYNAMIC_DEBOUNCE_MS });
        expect(screen.findByTestId('session-access-principal-visual:group:acme:dev')?.props.accessibilityElementsHidden).toBe(true);
    });

    it('moves selection off an acknowledged removal and announces it, never on an ordinary row mutation', async () => {
        const intent = actions();
        const screen = await renderScreen(<SessionAccessEditor model={model()} actions={intent} presentation="full" />);
        await screen.pressByTestIdAsync('session-access-grant-account:alice');
        expect(screen.findByTestId('session-access-remove:account:alice')).not.toBeNull();

        // An acknowledged level change republishes the same row: the open body and
        // the selection anchor must survive it untouched.
        await screen.update(<SessionAccessEditor actions={intent} presentation="full" model={model({
            revision: 2,
            grants: [{ ...alice, level: { kind: 'editable', value: 'view', options: alice.level.kind === 'editable' ? alice.level.options : [] } }, team],
        })} />);
        expect(announceAccessibilityMessage).not.toHaveBeenCalled();
        expect(screen.findByTestId('session-access-remove:account:alice')).not.toBeNull();

        await screen.update(<SessionAccessEditor model={model({ revision: 3, grants: [team] })} actions={intent} presentation="full" />);
        expect(announceAccessibilityMessage).toHaveBeenCalledWith(expect.stringContaining('Alice'));
        // Selection moved to the next remaining grant, so that row's body is the open one.
        expect(screen.findByTestId('session-access-remove-reason:team:acme')).not.toBeNull();
        expect(screen.findByTestId('session-access-remove:account:alice')).toBeNull();
    });
});
