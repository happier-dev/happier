import { publishPresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { writeClipboardStringFromUi } from '@/utils/ui/clipboard';

/**
 * Copy a storage item's path on its machine (the daemon's exact path, for pasting into a prompt or a terminal there).
 * Clipboard only: it never opens or touches the item. Agents reach the same text through `clipboard.write` with a
 * path read from the storage Actions.
 */
export function copyStoragePath(path: string): void {
  fireAndForget(
    writeClipboardStringFromUi(path, (actionId: 'clipboard.write', input) =>
      createFrontDoorActionExecute()(actionId, input, { surface: 'ui' })).then((result) => {
      if (result.ok && typeof result.result === 'object' && result.result !== null
        && 'status' in result.result && result.result.status === 'copied')
        publishPresentationNotice({ key: 'machine-storage:path-copied', severity: 'info', message: t('common.copied') });
    }),
    { tag: 'MachineStorage.copyPath' },
  );
}
