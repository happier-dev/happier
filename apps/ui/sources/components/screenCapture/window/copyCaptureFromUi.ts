import type { ActionExecuteFailure, ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { resolveInvocationAuthority } from '@happier-dev/protocol/actions/invocationAuthority';
import { executeScreenCaptureCopy, type CaptureCopyInput } from '@/sync/ops/actions/screenCaptureCopyAction';
import { beginClipboardWriteFromUi } from '@/utils/ui/clipboard';

export function copyCaptureFromUi(input: CaptureCopyInput,
    prepare?: () => Promise<void | ActionExecuteFailure>): Promise<ActionExecuteResult> {
    const clipboard = beginClipboardWriteFromUi(input.content === 'windowText' ? 'text/plain' : 'image/png');
    const executor = createActionExecutor({ screenCaptureAction: args => executeScreenCaptureCopy(args, {
        captureWindowPress: true, prepare,
        clipboard: {
            image: png => clipboard.write(new Blob([png as BlobPart], { type: 'image/png' })),
            text: text => clipboard.write(new Blob([text], { type: 'text/plain' })),
        },
    }) });
    return executor.execute('screenCapture.copy', input, {
        surface: 'ui', actionCaller: { kind: 'host' },
        authority: resolveInvocationAuthority({ credential: 'none', surface: 'ui', localUiInteraction: true }),
    }).finally(() => clipboard.refuse());
}
