import type * as React from 'react';

import { RIGHT_SIDEBAR_BUILTIN_TABS, type RightSidebarBuiltInTabId } from '@/components/appShell/rightSidebar/rightSidebarBuiltinTabs';
import type { SessionBoardAddIntent, SessionBoardCommand } from '@/components/sessions/board/useSessionBoardController';
import { resolveSessionCompanionPickerSections } from '@/components/sessions/companion/sessionCompanionContentModel';
import type {
    SessionCompanionBuiltinItemId,
    SessionCompanionItemRefV1,
} from '@/components/sessions/companion/state/sessionCompanionPreference';
import type { IconName } from '@/components/ui/icons/Icon';
import { resolveBoardWidgetProvenance } from '@/components/widgets/boardWidgetProvenance';
import type { WidgetCandidate } from '@/components/widgets/widgetCatalog';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import type { SessionBoardSnapshot } from '@/sync/domains/session/board';
import { t } from '@/text';

import type { WidgetAddAsk, WidgetAddEntry, WidgetAddSection } from './widgetAddModel';

/** Whether this Board already holds a record of that installed widget (the tile stays, marked Added). */
function isOnBoard(snapshot: SessionBoardSnapshot | null, candidate: WidgetCandidate): boolean {
    if (!snapshot) return false;
    for (const item of snapshot.itemsById.values()) {
        if (item.state.kind !== 'ready') continue;
        const source = item.state.item.source;
        if (source.kind === 'installedSurface'
            && source.surface.pluginId === candidate.surface.pluginId
            && source.surface.localId === candidate.surface.localId) return true;
    }
    return false;
}

/**
 * What the Board's Add popover offers. Every section is gated by the Board controller's own
 * `addIntents` (a source with no producer is absent, never inert), and every pick is one of the
 * controller's existing commands — no second write path.
 */
export function buildBoardWidgetAddContent(input: Readonly<{
    intents: readonly SessionBoardAddIntent[];
    /** The Board's one current-Session candidate list. */
    candidates: readonly WidgetCandidate[];
    snapshot: SessionBoardSnapshot | null;
    run: (command: SessionBoardCommand) => Promise<void> | void;
    /** The real widget body at this Session's data; absent when no plugin runtime is mounted. */
    renderPluginPreview?: (candidate: WidgetCandidate) => React.ReactNode;
    /** Opens the plugin catalog ("Find more widgets"). */
    openPlugins: () => void;
}>): Readonly<{ sections: readonly WidgetAddSection[]; ask?: WidgetAddAsk }> {
    const { intents, run, renderPluginPreview } = input;
    const plugins: WidgetAddEntry[] = intents.includes('fromPlugins')
        ? input.candidates.map((candidate) => ({
            id: `plugin-${candidate.key}`,
            title: candidate.title,
            subtitle: candidate.sharedPluginName ? `${candidate.pluginName} (${candidate.surface.pluginId})` : candidate.pluginName,
            icon: candidate.icon,
            added: isOnBoard(input.snapshot, candidate),
            ...(renderPluginPreview ? { renderPreview: () => renderPluginPreview(candidate) } : {}),
            onPick: () => { void run({ kind: 'item.addInstalled', surface: candidate.surface, title: candidate.title }); },
        }))
        : [];
    const make: WidgetAddEntry[] = [];
    if (intents.includes('walkthrough')) {
        make.push({
            id: 'walkthrough',
            title: t('walkthrough.eyebrow'),
            subtitle: t('walkthrough.none.reason'),
            icon: 'path',
            closesOnPick: true,
            added: input.snapshot ? [...input.snapshot.itemsById.values()].some((item) => item.state.kind === 'ready' && item.state.item.source.kind === 'walkthrough') : false,
            onPick: () => { void run({ kind: 'add', intent: 'walkthrough' }); },
        });
    }
    if (intents.includes('note')) {
        make.push({
            id: 'note',
            title: t('sessionBoard.add.note'),
            subtitle: t('widgetAdd.noteSubtitle'),
            icon: 'note',
            closesOnPick: true,
            onPick: () => { void run({ kind: 'add', intent: 'note' }); },
        });
    }
    if (intents.includes('interactiveView')) {
        make.push({
            id: 'interactiveView',
            title: t('sessionBoard.add.interactiveView'),
            subtitle: t('widgetAdd.interactiveViewSubtitle'),
            icon: 'code',
            closesOnPick: true,
            onPick: () => { void run({ kind: 'add', intent: 'interactiveView' }); },
        });
    }
    if (intents.includes('fromPlugins')) {
        make.push({
            id: 'findMore',
            title: t('widgetAdd.findMore'),
            subtitle: t('widgetAdd.findMoreSubtitle'),
            icon: 'squares-four',
            closesOnPick: true,
            onPick: input.openPlugins,
        });
    }
    const ask: WidgetAddAsk | undefined = intents.includes('askAgent') ? {
        title: t('widgetAdd.askTitle'),
        draft: t('sessionBoard.empty.editor.askAgentPrompt'),
        note: t('widgetAdd.askNote'),
        onPick: () => { void run({ kind: 'add', intent: 'askAgent' }); },
    } : undefined;
    return {
        sections: [
            { id: 'plugins', title: t('widgetAdd.fromPlugins'), hint: t('widgetAdd.fromPluginsHint'), kind: 'preview', entries: plugins },
            { id: 'make', title: t('widgetAdd.makeOne'), kind: 'make', entries: make },
        ],
        ...(ask ? { ask } : {}),
    };
}

const BUILTIN_ICONS = {
    session_summary: 'stack',
    agent_plan: 'list-checks',
    changes: 'git-branch',
    local_services: 'hard-drives',
} as const satisfies Record<SessionCompanionBuiltinItemId, IconName>;

function builtinTitle(id: SessionCompanionBuiltinItemId): string {
    switch (id) {
        case 'session_summary': return t('sessionBoard.companion.summary.title');
        case 'agent_plan': return t('sessionCompanion.plan.title');
        case 'changes': return t('widgetGlances.changesTitle');
        case 'local_services': return t('widgetGlances.localServicesTitle');
    }
}

/**
 * Panes the Companion links to rather than shows (lab WC3, bounded C3): every session pane except
 * the Board (its widgets are listed themselves) and the panes that already have a glance (Git →
 * Changes, Local services).
 */
const PANES_WITH_THEIR_OWN_ENTRY: ReadonlySet<RightSidebarBuiltInTabId> = new Set(['board', 'git', 'services']);

/**
 * What Add to Companion offers (lab `cwidgets` WC3, round 2): Glances (built-ins and plugin views
 * that declare the `companion` placement), what is On this board, and Panes, added as a link that
 * opens in Details. Every pick is one reference through the Companion's one add path; nothing is
 * created on the Board.
 */
export function buildCompanionWidgetAddSections(input: Readonly<{
    refs: readonly SessionCompanionItemRefV1[];
    snapshot: SessionBoardSnapshot | null;
    /** Plugin views that declare the `companion` placement, from the current plugin runtime. */
    glanceCandidates: readonly WidgetCandidate[];
    pluginProjection: PluginUiProjectionModel | null | undefined;
    addItem: (ref: SessionCompanionItemRefV1) => void;
    renderGlancePreview?: (id: SessionCompanionBuiltinItemId) => React.ReactNode;
    /**
     * A Board note's body, drawn inert at static props. Only declarative items get one: an
     * interactive view or a plugin widget would need an executable mount, which a popover never makes.
     */
    renderNotePreview?: (document: unknown) => React.ReactNode;
}>): readonly WidgetAddSection[] {
    const { refs, addItem, renderGlancePreview, renderNotePreview } = input;
    const model = resolveSessionCompanionPickerSections({ refs, snapshot: input.snapshot, candidates: input.glanceCandidates });
    const glances: WidgetAddEntry[] = [
        ...model.builtIn.map((row): WidgetAddEntry => ({
            id: `builtin-${row.id}`,
            title: builtinTitle(row.id),
            subtitle: t('widgetAdd.builtIn'),
            icon: BUILTIN_ICONS[row.id],
            added: row.added,
            ...(renderGlancePreview ? { renderPreview: () => renderGlancePreview(row.id) } : {}),
            onPick: () => addItem({ kind: 'builtin', id: row.id }),
        })),
        ...model.plugins.map((row): WidgetAddEntry => ({
            id: `plugin-${row.key}`,
            title: row.candidate.title,
            subtitle: row.candidate.pluginName,
            icon: row.candidate.icon,
            added: row.added,
            onPick: () => addItem({ kind: 'plugin', surface: row.candidate.surface }),
        })),
    ];
    const board: WidgetAddEntry[] = model.board.map((row): WidgetAddEntry => {
        const source = row.source;
        const notePreview = renderNotePreview && source.kind === 'declarative'
            ? { renderPreview: () => renderNotePreview(source.document) }
            : {};
        return {
            id: `board-${row.widgetId}`,
            title: row.title,
            subtitle: resolveBoardWidgetProvenance(source, input.pluginProjection).label,
            icon: source.kind === 'declarative' ? 'note' : 'squares-four',
            added: row.added,
            ...notePreview,
            onPick: () => addItem({ kind: 'widget', widgetId: row.widgetId }),
        };
    });
    const panes: WidgetAddEntry[] = RIGHT_SIDEBAR_BUILTIN_TABS
        .filter((tab) => tab.scopes.includes('session') && !PANES_WITH_THEIR_OWN_ENTRY.has(tab.id))
        .map((tab) => ({
            id: `pane-${tab.id}`,
            title: t(tab.labelKey),
            icon: tab.icon,
            added: refs.some((ref) => ref.kind === 'pane' && ref.paneId === tab.id),
            onPick: () => addItem({ kind: 'pane', paneId: tab.id }),
        }));
    return [
        { id: 'glances', title: t('widgetAdd.glances'), hint: t('widgetAdd.glancesHint'), kind: 'preview', entries: glances },
        { id: 'board', title: t('widgetAdd.onBoard'), hint: t('widgetAdd.onBoardHint'), kind: 'preview', entries: board },
        { id: 'panes', title: t('widgetAdd.panes'), hint: t('widgetAdd.panesHint'), kind: 'chips', entries: panes },
    ];
}
