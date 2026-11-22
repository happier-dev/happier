import type { ToolCall } from '@happier-dev/session-core/messages';
import { resolveToolStatusIndicatorKind } from '@happier-dev/session-core/tools';

import { t } from '@/text';

import { isRecord, readHappierActionToolResultCandidates } from './happierActionToolResult';
import type { TranscriptBrowserActionReference } from './transcriptBrowserActionReference';

/** Where a browser call stands, as the row tells it: asked and waiting, done, or ended without doing it. */
export type BrowserCallOutcome = 'pending' | 'completed' | 'failed';

/**
 * The call's outcome from the tool status owner. A call that only created an approval request has asked and
 * has no outcome of its own yet (its approved run reports separately), so it reads as asked.
 */
export function readBrowserCallOutcome(tool: ToolCall): BrowserCallOutcome {
    switch (resolveToolStatusIndicatorKind(tool)) {
        case 'error':
        case 'permission_blocked':
        case 'stopped':
            return 'failed';
        case 'completed':
            return readHappierActionToolResultCandidates(tool.result).some(isApprovalRequestCreated) ? 'pending' : 'completed';
        default:
            return 'pending';
    }
}

/** The Action executor's answer when the call waits for a person: the bare result or its `{ ok, result }` envelope. */
function isApprovalRequestCreated(candidate: unknown): boolean {
    if (!isRecord(candidate)) return false;
    return candidate.kind === 'approval_request_created'
        || (isRecord(candidate.result) && candidate.result.kind === 'approval_request_created');
}

/**
 * What the agent did in the browser, in words, in the tense of the call's outcome: the ask in the present
 * while it waits (for approval or for the page), the deed in the past once done, and the existing
 * "Couldn't finish" line around the ask when it failed. Never a past tense before there is an outcome.
 */
export function describeBrowserAction(reference: TranscriptBrowserActionReference, outcome: BrowserCallOutcome): string {
    if (outcome === 'completed') return describe(reference, PAST);
    const asked = describe(reference, PRESENT);
    return outcome === 'failed' ? t('approvals.failureNamed', { action: asked }) : asked;
}

type Phrases = typeof PAST;

const PAST = {
    opened: (page: string) => t('browserTool.opened', { page }),
    openedPage: () => t('browserTool.openedPage'),
    reloaded: () => t('browserTool.reloaded'),
    wentBack: () => t('browserTool.wentBack'),
    wentForward: () => t('browserTool.wentForward'),
    clicked: (target: string) => t('browserTool.clicked', { target }),
    clickedPage: () => t('browserTool.clickedPage'),
    typedInto: (target: string) => t('browserTool.typedInto', { target }),
    typed: () => t('browserTool.typed'),
    filledIn: (target: string) => t('browserTool.filledIn', { target }),
    filled: () => t('browserTool.filled'),
    pressed: (key: string) => t('browserTool.pressed', { key }),
    pressedKey: () => t('browserTool.pressedKey'),
    scrolled: () => t('browserTool.scrolled'),
    pointedAt: (target: string) => t('browserTool.pointedAt', { target }),
    pointed: () => t('browserTool.pointed'),
    choseIn: (target: string) => t('browserTool.choseIn', { target }),
    chose: () => t('browserTool.chose'),
    uploadedTo: (target: string) => t('browserTool.uploadedTo', { target }),
    uploaded: () => t('browserTool.uploaded'),
    dragged: (target: string) => t('browserTool.dragged', { target }),
    draggedPage: () => t('browserTool.draggedPage'),
    looked: () => t('browserTool.looked'),
    screenshot: () => t('browserTool.screenshot'),
    recordingStarted: () => t('browserTool.recordingStarted'),
    recordingStopped: () => t('browserTool.recordingStopped'),
    other: () => t('browserTool.other'),
};

const PRESENT: Phrases = {
    opened: (page) => t('browserTool.present.opened', { page }),
    openedPage: () => t('browserTool.present.openedPage'),
    reloaded: () => t('browserTool.present.reloaded'),
    wentBack: () => t('browserTool.present.wentBack'),
    wentForward: () => t('browserTool.present.wentForward'),
    clicked: (target) => t('browserTool.present.clicked', { target }),
    clickedPage: () => t('browserTool.present.clickedPage'),
    typedInto: (target) => t('browserTool.present.typedInto', { target }),
    typed: () => t('browserTool.present.typed'),
    filledIn: (target) => t('browserTool.present.filledIn', { target }),
    filled: () => t('browserTool.present.filled'),
    pressed: (key) => t('browserTool.present.pressed', { key }),
    pressedKey: () => t('browserTool.present.pressedKey'),
    scrolled: () => t('browserTool.present.scrolled'),
    pointedAt: (target) => t('browserTool.present.pointedAt', { target }),
    pointed: () => t('browserTool.present.pointed'),
    choseIn: (target) => t('browserTool.present.choseIn', { target }),
    chose: () => t('browserTool.present.chose'),
    uploadedTo: (target) => t('browserTool.present.uploadedTo', { target }),
    uploaded: () => t('browserTool.present.uploaded'),
    dragged: (target) => t('browserTool.present.dragged', { target }),
    draggedPage: () => t('browserTool.present.draggedPage'),
    looked: () => t('browserTool.present.looked'),
    screenshot: () => t('browserTool.present.screenshot'),
    recordingStarted: () => t('browserTool.present.recordingStarted'),
    recordingStopped: () => t('browserTool.present.recordingStopped'),
    other: () => t('browserTool.present.other'),
};

function describe(reference: TranscriptBrowserActionReference, say: Phrases): string {
    const target = reference.targetLabel;
    switch (reference.verb) {
        case 'open':
            return reference.pageLabel ? say.opened(reference.pageLabel) : say.openedPage();
        case 'reload':
            return say.reloaded();
        case 'back':
            return say.wentBack();
        case 'forward':
            return say.wentForward();
        case 'click':
            return target ? say.clicked(target) : say.clickedPage();
        case 'type':
            return target ? say.typedInto(target) : say.typed();
        case 'fill':
            return target ? say.filledIn(target) : say.filled();
        case 'press':
            return reference.keyLabel ? say.pressed(reference.keyLabel) : say.pressedKey();
        case 'scroll':
            return say.scrolled();
        case 'point':
            return target ? say.pointedAt(target) : say.pointed();
        case 'select':
            return target ? say.choseIn(target) : say.chose();
        case 'upload':
            return target ? say.uploadedTo(target) : say.uploaded();
        case 'drag':
            return target ? say.dragged(target) : say.draggedPage();
        case 'look':
            return say.looked();
        case 'screenshot':
            return say.screenshot();
        case 'recordingStarted':
            return say.recordingStarted();
        case 'recordingStopped':
            return say.recordingStopped();
        case 'other':
            return say.other();
    }
}
