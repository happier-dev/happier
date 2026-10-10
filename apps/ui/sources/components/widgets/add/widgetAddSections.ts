import type * as React from 'react';
import { randomUUID } from '@/platform/randomUUID';

import { RIGHT_SIDEBAR_BUILTIN_TABS, type RightSidebarBuiltInTabId } from '@/components/appShell/rightSidebar/rightSidebarBuiltinTabs';
import type { SessionBoardAddIntent, SessionBoardCommand, SessionBoardCommandOutcome } from '@/components/sessions/board/useSessionBoardController';
import { resolveSessionCompanionPickerSections } from '@/components/sessions/companion/sessionCompanionContentModel';
import type {
    SessionCompanionBuiltinItemId,
    SessionCompanionItemRefV1,
} from '@/components/sessions/companion/state/sessionCompanionPreference';
import { SESSION_COMPANION_BUILTIN_ITEM_IDS } from '@/components/sessions/companion/state/sessionCompanionPreference';
import { resolveBoardWidgetProvenance } from '@/components/widgets/boardWidgetProvenance';
import { describeWidgetCandidatePurpose, type WidgetCandidate } from '@/components/widgets/widgetCatalog';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import type { SessionBoardSnapshot } from '@/sync/domains/session/board';
import { t } from '@/text';

import {
    buildWidgetCandidateSetup,
    countWidgetInstances,
    groupWidgetCandidatesByPlugin,
    isConfigurableWidgetCandidate,
    partitionWidgetCandidatesBySource,
    selectHostableWidgetCandidates,
    runAcknowledgedWidgetSetupCommand,
    runWidgetSetupCommand,
    widgetDefinitionOfCandidate,
    widgetSetupFieldsForCandidate,
    type WidgetSurfaceContext,
    type WidgetSetupCommandResult,
} from '@/components/widgets/surface/widgetSurfaceSetup';
import { normalizeWidgetSizeForSurfaceV1, readBuiltinWidgetDescriptorV1, type WidgetInputBindingsV1, type WidgetInstanceV1, type WidgetSizeV1, type WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';

import type { WidgetAddAsk, WidgetAddEntry, WidgetAddSection } from './widgetAddModel';
import { proposeWidgetSetupDraft, type WidgetSetup, type WidgetSetupSubmitResult } from './widgetSetupModel';

type WidgetSetupPreview = Parameters<NonNullable<WidgetSetup['renderPreview']>>[0];

const NO_CONTEXT: WidgetSurfaceContext = Object.freeze({});

/** The configured widget copies already on this Board (the gallery counts them by definition). */
function boardWidgetInstances(snapshot: SessionBoardSnapshot | null): WidgetInstanceV1[] {
    if (!snapshot) return [];
    const instances: WidgetInstanceV1[] = [];
    for (const item of snapshot.itemsById.values()) {
        if (item.state.kind === 'ready' && item.state.item.source.kind === 'widget') instances.push(item.state.item.source.instance);
    }
    return instances;
}

/** The bindings a pick starts with when it needs no step (every input follows or none exist). */
function startingBindings(candidate: WidgetCandidate, context: WidgetSurfaceContext, audience: 'personal' | 'shared'): WidgetInputBindingsV1 {
    return proposeWidgetSetupDraft(widgetSetupFieldsForCandidate(candidate, context, audience)).bindings;
}

/**
 * What the Board's Add popover offers. Every section is gated by the Board controller's own
 * `addIntents` (a source with no producer is absent, never inert). Installed picks use the existing
 * controller command; saved definitions require the canonical shared-publication Action callback.
 */
export function buildBoardWidgetAddContent(input: Readonly<{
    intents: readonly SessionBoardAddIntent[];
    /** Current installed candidates and Account saved-definition summaries. */
    candidates: readonly WidgetCandidate[];
    snapshot: SessionBoardSnapshot | null;
    run: (command: SessionBoardCommand) => Promise<SessionBoardCommandOutcome | null | void> | void;
    /** The selected widget's live preview at the chosen inputs. */
    renderSetupPreview?: (candidate: WidgetCandidate, preview: WidgetSetupPreview) => React.ReactNode;
    /** The qualified surface this adds to (option reads and previews are admitted for it). */
    scope?: WidgetSurfaceRefV1 | null;
    /** What the Board fills on its own: its Session ("This session"). */
    context?: WidgetSurfaceContext;
    /** Saved private definitions enter the canonical shared-publication Action, never direct upsert. */
    publishSavedWidget?: (instance: WidgetInstanceV1, size?: WidgetSizeV1) => Promise<WidgetSetupSubmitResult>;
    /** Opens the plugin catalog ("Find more widgets"). */
    openPlugins: () => void;
}>): Readonly<{ sections: readonly WidgetAddSection[]; ask?: WidgetAddAsk }> {
    const { intents, run, renderSetupPreview, publishSavedWidget } = input;
    const context = input.context ?? NO_CONTEXT;
    const instances = boardWidgetInstances(input.snapshot);
    const widgetEntry = (candidate: WidgetCandidate): WidgetAddEntry[] => {
        const definition = widgetDefinitionOfCandidate(candidate);
        const copies = countWidgetInstances(instances, definition);
        const add = definition.kind === 'artifact'
            ? (publishSavedWidget ? (bindings: WidgetInputBindingsV1, size?: WidgetSizeV1) => publishSavedWidget({ v: 1, id: randomUUID(), definition, bindings, displayName: candidate.title }, normalizeWidgetSizeForSurfaceV1('sessionBoard', size, candidate.sizeDeclaration)) : null)
            : (bindings: WidgetInputBindingsV1, size?: WidgetSizeV1) => runAcknowledgedWidgetSetupCommand(() => run({ kind: 'item.addWidget', definition, title: candidate.title, bindings,
                size: normalizeWidgetSizeForSurfaceV1('sessionBoard', size, candidate.sizeDeclaration) }), t('widgetAdd.addFailed'));
        if (!add) return [];
        // A widget with inputs is counted and can be added again, differently bound; one without
        // inputs stays Added, because a second identical copy would show the same thing (dbind G).
        const configurable = isConfigurableWidgetCandidate(candidate);
        const proposed = buildWidgetCandidateSetup({ candidate, context, audience: 'shared',
            mode: { kind: 'add', submitLabel: t('widgetAdd.addToBoard') }, submit: draft => add(draft.bindings, draft.size), scope: input.scope ?? null,
            ...(renderSetupPreview ? { renderPreview: (preview: WidgetSetupPreview) => renderSetupPreview(candidate, preview) } : {}) });
        return [{
            id: `plugin-${candidate.key}`,
            title: candidate.title,
            // Its sections already name where it comes from, so the row's line is its purpose.
            ...(candidate.description ? { subtitle: candidate.description } : {}),
            icon: candidate.icon,
            ...(configurable
                ? (copies > 0 ? { count: t('widgetAdd.countOnBoard', { count: copies }) } : {})
                : { added: copies > 0 }),
            // Every widget is added from its pane: inputs, live body at its size, then Add.
            setup: () => proposed,
        }];
    };
    const widgets = partitionWidgetCandidatesBySource(selectHostableWidgetCandidates(input.candidates, 'sessionBoard'));
    const offered = intents.includes('fromPlugins');
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
            { id: 'builtins', title: t('widgetAdd.builtIn'), entries: offered ? widgets.builtIn.flatMap(widgetEntry) : [] },
            ...(offered ? groupWidgetCandidatesByPlugin(widgets.fromPlugins).map((group) => ({
                id: `plugin:${group.id}`, title: group.title, hint: t('widgetAdd.pluginTag'), pluginId: group.id, entries: group.candidates.flatMap(widgetEntry),
            })) : []),
            ...(publishSavedWidget && widgets.yours.length ? [{ id: 'yours', title: t('widgetDefinition.yourWidgets'), hint: t('widgetDefinition.yourWidgetsHint'), entries: widgets.yours.flatMap(widgetEntry) }] : []),
            { id: 'make', title: t('widgetAdd.makeOne'), entries: make },
        ],
        ...(ask ? { ask } : {}),
    };
}

/**
 * Panes the Companion links to rather than shows (lab WC3, bounded C3): every session pane except
 * the Board (its widgets are listed themselves) and the panes that already have a glance (Git →
 * Changes, Local services).
 */
const PANES_WITH_THEIR_OWN_ENTRY: ReadonlySet<RightSidebarBuiltInTabId> = new Set(['board', 'git', 'services']);

/**
 * What Add to Companion offers: builtin content and configured plugin instances,
 * what is On this board, and Panes, added as a link that
 * opens in Details. Every pick is one reference through the Companion's one add path; nothing is
 * created on the Board.
 */
export function buildCompanionWidgetAddSections(input: Readonly<{
    refs: readonly SessionCompanionItemRefV1[];
    snapshot: SessionBoardSnapshot | null;
    /** Universal plugin widget candidates, from the current plugin runtime. */
    glanceCandidates: readonly WidgetCandidate[];
    pluginProjection: PluginUiProjectionModel | null | undefined;
    addItem: (ref: SessionCompanionItemRefV1) => WidgetSetupCommandResult | Promise<WidgetSetupCommandResult>;
    /** What the Companion fills on its own: its Session ("This session"). */
    context?: WidgetSurfaceContext;
    /** The Set up step's live preview at the chosen inputs (Session B beside Session A, dbind X). */
    renderSetupPreview?: (candidate: WidgetCandidate, preview: WidgetSetupPreview) => React.ReactNode;
    /** The qualified surface this adds to (option reads and previews are admitted for it). */
    scope?: WidgetSurfaceRefV1 | null;
    renderGlancePreview?: (id: SessionCompanionBuiltinItemId) => React.ReactNode;
    /**
     * A Board note's body, drawn inert at static props. Only declarative items get one: an
     * interactive view or a plugin widget would need an executable mount, which a popover never makes.
     */
    renderNotePreview?: (document: unknown) => React.ReactNode;
}>): readonly WidgetAddSection[] {
    const { refs, addItem, renderGlancePreview, renderNotePreview, renderSetupPreview } = input;
    const context = input.context ?? NO_CONTEXT;
    const personalInstances = refs.flatMap((ref) => (ref.kind === 'instance' ? [ref.instance] : []));
    const glanceCandidates = selectHostableWidgetCandidates(input.glanceCandidates, 'companion');
    const model = resolveSessionCompanionPickerSections({ refs, snapshot: input.snapshot, candidates: glanceCandidates });
    const candidatesBySource = partitionWidgetCandidatesBySource(glanceCandidates);
    const yourKeys = new Set(candidatesBySource.yours.map(candidate => `plugin-${candidate.key}`));
    const glances: WidgetAddEntry[] = [
        ...model.plugins.map((row): WidgetAddEntry => {
            const candidate = row.candidate;
            const definition = widgetDefinitionOfCandidate(candidate);
            const native = readBuiltinWidgetDescriptorV1(definition);
            const nativeGlanceId = SESSION_COMPANION_BUILTIN_ITEM_IDS.find(id => id === native?.definition.id);
            // A direct personal copy: its own definition reference and bindings, kept on this device.
            const add = (bindings: WidgetInputBindingsV1) => addItem({ kind: 'instance', instance: { v: 1, id: randomUUID(), definition, bindings } });
            const configurable = isConfigurableWidgetCandidate(candidate);
            const copies = countWidgetInstances(personalInstances, definition);
            const base = {
                id: `plugin-${row.key}`,
                title: candidate.title,
                subtitle: describeWidgetCandidatePurpose(candidate),
                icon: candidate.icon,
                ...(configurable
                    ? (copies > 0 ? { count: t('widgetAdd.countInCompanion', { count: copies }) } : {})
                    : { added: copies > 0 || row.added }),
            };
            // A widget with inputs (or an Account definition) is set up in its pane; a glance without
            // inputs shows its own live preview there and adds as it is.
            return configurable || definition.kind === 'artifact' ? {
                ...base,
                setup: () => buildWidgetCandidateSetup({
                    candidate,
                    context,
                    audience: 'personal',
                    mode: { kind: 'add', submitLabel: t('widgetAdd.addToCompanion') },
                    submit: (draft) => runWidgetSetupCommand(() => add(draft.bindings), t('widgetAdd.addFailed')),
                    ...(renderSetupPreview ? { renderPreview: (preview: WidgetSetupPreview) => renderSetupPreview(candidate, preview) } : {}),
                    scope: input.scope ?? null,
                }),
            } : {
                ...base,
                ...(nativeGlanceId && renderGlancePreview ? { renderPreview: () => renderGlancePreview(nativeGlanceId) } : {}),
                onPick: () => runWidgetSetupCommand(() => add(startingBindings(candidate, context, 'personal')), t('widgetAdd.addFailed')),
            };
        }),
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
            onPick: () => runWidgetSetupCommand(() => addItem({ kind: 'widget', widgetId: row.widgetId }), t('widgetAdd.addFailed')),
        };
    });
    const panes: WidgetAddEntry[] = RIGHT_SIDEBAR_BUILTIN_TABS
        .filter((tab) => tab.scopes.includes('session') && !PANES_WITH_THEIR_OWN_ENTRY.has(tab.id))
        .map((tab) => ({
            id: `pane-${tab.id}`,
            title: t(tab.labelKey),
            icon: tab.icon,
            added: refs.some((ref) => ref.kind === 'pane' && ref.paneId === tab.id),
            onPick: () => runWidgetSetupCommand(() => addItem({ kind: 'pane', paneId: tab.id }), t('widgetAdd.addFailed')),
        }));
    return [
        { id: 'glances', title: t('widgetAdd.glances'), hint: t('widgetAdd.glancesHint'), entries: glances.filter(entry => !yourKeys.has(entry.id)) },
        ...(candidatesBySource.yours.length ? [{ id: 'yours', title: t('widgetDefinition.yourWidgets'), hint: t('widgetDefinition.yourWidgetsHint'),
            entries: glances.filter(entry => yourKeys.has(entry.id)) }] : []),
        { id: 'board', title: t('widgetAdd.onBoard'), hint: t('widgetAdd.onBoardHint'), entries: board },
        { id: 'panes', title: t('widgetAdd.panes'), hint: t('widgetAdd.panesHint'), entries: panes },
    ];
}
