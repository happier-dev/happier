import { Modal } from '@/modal';
import type { ScmRemoteConfirmPolicy } from '@/scm/settings/preferences';
import {
    setRemoteConfirmationForKind,
    shouldConfirmRemoteOperation,
} from '@/scm/settings/remoteConfirmationPolicy';
import { t } from '@/text';

import { formatRemoteTargetForDisplay, type RemoteTargetDisplay } from './remoteFeedback';

export async function confirmCommitAdjacentPush(input: Readonly<{
    target: RemoteTargetDisplay;
    policy: ScmRemoteConfirmPolicy;
    setRemoteConfirmPolicy: (policy: ScmRemoteConfirmPolicy) => void;
    detachedHeadLabel: string;
}>): Promise<boolean> {
    if (!shouldConfirmRemoteOperation(input.policy, 'push')) {
        return true;
    }

    const displayTarget = formatRemoteTargetForDisplay(input.target, input.detachedHeadLabel);
    let confirmed = false;
    await Modal.alertAsync(
        t('files.commitAdjacentPush.confirm.title'),
        t('files.commitAdjacentPush.confirm.body', { target: displayTarget }),
        [
            {
                text: t('files.commitAdjacentPush.confirm.notNow'),
                style: 'cancel',
                onPress: () => {
                    confirmed = false;
                },
            },
            {
                text: t('files.commitAdjacentPush.confirm.push'),
                onPress: () => {
                    confirmed = true;
                },
            },
            {
                text: t('files.commitAdjacentPush.confirm.pushAndDontAskAgain'),
                onPress: () => {
                    input.setRemoteConfirmPolicy(
                        setRemoteConfirmationForKind(input.policy, 'push', false),
                    );
                    confirmed = true;
                },
            },
        ],
    );

    return confirmed;
}
