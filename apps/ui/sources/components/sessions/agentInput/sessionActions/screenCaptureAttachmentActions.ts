import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ScreenCaptureStartInputSchema } from '@happier-dev/protocol/actions/actionSpecs';
import { desktopHostKind } from '@/utils/platform/desktopHost';

type CaptureStart = ReturnType<typeof ScreenCaptureStartInputSchema.parse>;
type SessionTarget = NonNullable<CaptureStart['targetSession']>;
export type ScreenCaptureAttachmentAction = Readonly<{
    id: 'capture-screen' | 'record-screen' | 'attach-recent-capture';
    run: () => void | Promise<unknown>;
}>;

/** The Attach presenter supplies its mounted Action executor and the existing recent picker. */
export function createScreenCaptureAttachmentActions(input: Readonly<{
    targetSession: SessionTarget;
    execute: (actionId: 'screenCapture.start', input: CaptureStart) => Promise<ActionExecuteResult>;
    openRecent: (targetSession: SessionTarget) => void | Promise<unknown>;
}>): readonly ScreenCaptureAttachmentAction[] {
    if (desktopHostKind() !== 'tauri') return [];
    return [
        { id: 'capture-screen', run: () => input.execute('screenCapture.start', { mode: 'screenshot', targetSession: input.targetSession }) },
        { id: 'record-screen', run: () => input.execute('screenCapture.start', { mode: 'recording', targetSession: input.targetSession }) },
        { id: 'attach-recent-capture', run: () => input.openRecent(input.targetSession) },
    ];
}
