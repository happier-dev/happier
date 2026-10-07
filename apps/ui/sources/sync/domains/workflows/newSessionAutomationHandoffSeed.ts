import { PluginJsonValueV2Schema } from '@happier-dev/protocol/plugins/contributions/jsonSchema';
import type { AutomationRunExecutionTargetV1 } from '@happier-dev/protocol/automations/automationRunExecutionRecipeV1';
import type { ComposerSnapshotV1 } from '@happier-dev/protocol/plugins/ui/composer';
import type { WorkflowAuthoringTarget } from './workflowProjectTarget';
import type { WorkflowBlock } from '@happier-dev/protocol/workflows/workflowV1';

import {
    authoringComposerSeedFromSnapshot,
    projectPortableAuthoringDocument,
    type AuthoringComposerSeed,
} from '@/components/sessions/authoring/authoringComposerCustody';
import { buildSessionServerStartSpawnDraftV1FromAuthoringDraft, resolveSessionAuthoringDirectoryIntent } from '@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters';
import type { SessionAuthoringDraft } from '@/components/sessions/authoring/draft/sessionAuthoringDraft';
import type { NewSessionAutomationDraft } from '@/sync/domains/automations/automationDraft';
import { getTempData, storeTempData } from '@/utils/sessions/tempDataStore';

import { projectLegacyAutomationRecipeToEditorDraft } from './automationRecipeWorkflowDraft';
import { createWorkflowEditorDraft, type WorkflowEditorDraft } from './workflowEditorDraft';
import { updateWorkflowBlock } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';

/**
 * The live composer document at the moment the chip was pressed, exactly as
 * its owner exposes it: placed references, attachments with their staged
 * content, and the caret when the composer reports one.
 *
 * The screen model does not rerender per keystroke, so a render projection can
 * lag the input — the destination must not be able to save or run a different
 * prompt than the one that was visible. The capture is therefore read from the
 * composer's own document owner at the action boundary, not from the
 * last-rendered draft, and nothing is stripped from it here.
 */
export type NewSessionAutomationComposerCapture = Pick<
    ComposerSnapshotV1,
    'text' | 'references' | 'attachments' | 'selection'
>;

/**
 * New Session's Automation entry, handed to the shared Automation editor.
 *
 * The chip no longer embeds a second settings editor: it transfers the draft
 * the person actually composed — prompt, authoring selections, exact machine
 * and project folder, plus any triggers already chosen — and the shared editor
 * owns it from there. The transfer travels through the existing temporary-data
 * store, so no prompt or setting ever appears in a URL, and the source draft is
 * untouched until the destination owns the handoff.
 */

export type NewSessionAutomationHandoffSeed = Readonly<{
    name: string;
    description: string | null;
    enabled: boolean;
    /** The composed prompt and settings as the canonical one-step definition. */
    draft: WorkflowEditorDraft;
    /** Exact placement, when the composed draft already resolved one. */
    project: WorkflowAuthoringTarget | null;
    triggers: NewSessionAutomationDraft['triggers'];
    /**
     * The exact composer document for the first step's custody. It lives only
     * in this in-memory handoff, never in the saved definition; without it the
     * destination composes from the portable draft as before.
     */
    composer?: AuthoringComposerSeed;
}>;

/**
 * Projects the live New Session draft into the shared editor's vocabulary.
 *
 * A composed draft that can produce a canonical spawn carries its complete
 * selection through the same seam a saved one-shot Automation uses. When it
 * cannot — an unresolved machine, or a target that has no spawn — the authored
 * prompt still transfers and the destination shows the placement as
 * unresolved rather than inventing one.
 */
/**
 * Replaces the projected one-step prompt with exactly what the composer holds.
 *
 * The saved draft takes the portable projection of that document — through
 * the same projection the destination composer publishes, so adopting the
 * exact document is never mistaken for a host edit — and the exact document
 * travels beside it for that step's custody.
 */
function withCapturedDocument(
    draft: WorkflowEditorDraft,
    capture: NewSessionAutomationComposerCapture | undefined,
): Readonly<{ draft: WorkflowEditorDraft; composer?: AuthoringComposerSeed }> {
    if (capture === undefined) return { draft };
    const first = draft.blocks[0];
    if (first === undefined || first.kind !== 'step') return { draft };
    const composer = authoringComposerSeedFromSnapshot(first.id, capture);
    const document = projectPortableAuthoringDocument(composer.document);
    const replaceDocument = (block: WorkflowBlock): WorkflowBlock => {
        if (block.kind !== 'step') return block;
        // Editor drafts deliberately allow incomplete steps; strict workflow
        // validation belongs to save/run admission, not this handoff.
        return {
            ...block,
            document: {
                text: document.text,
                references: [...document.references],
                attachments: document.attachments.map((attachment) => ({
                    ...attachment,
                    value: PluginJsonValueV2Schema.parse(attachment.value),
                })),
            },
        };
    };
    return {
        draft: updateWorkflowBlock(draft, first.id, replaceDocument),
        composer,
    };
}

export function buildNewSessionAutomationHandoffSeed(params: Readonly<{
    draftId: string;
    authoring: SessionAuthoringDraft;
    automation: NewSessionAutomationDraft;
    /** Read from the live composer at the action boundary, when one is mounted. */
    composer?: NewSessionAutomationComposerCapture;
}>): NewSessionAutomationHandoffSeed {
    const prompt = params.composer?.text ?? params.authoring.prompt;
    const name = params.automation.name.trim();
    const base = {
        name,
        description: params.automation.description.trim() || null,
        enabled: params.automation.enabled,
        triggers: params.automation.triggers,
    };

    let target: AutomationRunExecutionTargetV1 | null = null;
    try {
        target = {
            kind: 'newSession',
            spawn: buildSessionServerStartSpawnDraftV1FromAuthoringDraft({
                draft: params.authoring,
                permissionMode: params.authoring.permissionMode ?? 'default',
                configurationUpdatedAtMs: params.authoring.permissionModeUpdatedAt ?? 0,
            }),
        };
    } catch {
        target = null;
    }

    if (target !== null) {
        const projection = projectLegacyAutomationRecipeToEditorDraft({
            draftId: params.draftId,
            name,
            // The captured references are applied below through the one
            // document adapter, so the projector is not given a second, lossy
            // mention source to disagree with.
            program: { v: 1, prompt },
            target,
            machineId: null,
        });
        return {
            ...base,
            ...withCapturedDocument(projection.draft, params.composer),
            project: projection.project,
        };
    }

    const machineId = params.authoring.executionTarget?.kind === 'machine'
        ? params.authoring.executionTarget.target.machineId
        : null;
    const directoryIntent = resolveSessionAuthoringDirectoryIntent(params.authoring);
    return {
        ...base,
        ...withCapturedDocument(createWorkflowEditorDraft({
            draftId: params.draftId,
            name,
            blocks: [{
                kind: 'step',
                id: 'step-1',
                document: { text: prompt, references: [], attachments: [] },
                input: [],
                result: { kind: 'text' },
            }],
        }), params.composer),
        project: machineId === null
            ? null
            : directoryIntent.kind === 'managed'
                ? { machineId, directory: directoryIntent }
                : { machineId, directory: params.authoring.directory },
    };
}

const NEW_SESSION_AUTOMATION_HANDOFF_KIND = 'happier.new-session-automation-handoff.v1' as const;

type StoredHandoffSeed = Readonly<{
    kind: typeof NEW_SESSION_AUTOMATION_HANDOFF_KIND;
    seed: NewSessionAutomationHandoffSeed;
}>;

/** Returns the opaque route parameter carrying the composed draft. */
export function storeNewSessionAutomationHandoffSeed(seed: NewSessionAutomationHandoffSeed): string {
    return storeTempData({ kind: NEW_SESSION_AUTOMATION_HANDOFF_KIND, seed } satisfies StoredHandoffSeed);
}

/**
 * Reads the handoff exactly once. Returning through history therefore cannot
 * silently reseed a stale composed draft over edited work.
 */
export function readNewSessionAutomationHandoffSeed(dataId: string): NewSessionAutomationHandoffSeed | null {
    const stored = getTempData<StoredHandoffSeed>(dataId);
    if (stored === null || stored.kind !== NEW_SESSION_AUTOMATION_HANDOFF_KIND) return null;
    return stored.seed;
}
