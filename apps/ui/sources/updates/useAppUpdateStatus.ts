import * as React from 'react';
import { Linking, Platform } from 'react-native';
import { useRouter } from 'expo-router';

import { useDesktopUpdater } from '@/desktop/updates/useDesktopUpdater';
import { useChangelog } from '@/hooks/inbox/useChangelog';
import { useUpdates } from '@/hooks/inbox/useUpdates';
import { useNativeUpdate } from '@/hooks/ui/useNativeUpdate';
import { tLoose } from '@/text';

import { buildAppUpdateStatusModel } from './buildAppUpdateStatusModel';

export function useAppUpdateStatus() {
    const router = useRouter();
    const nativeUpdateUrl = useNativeUpdate();
    const desktop = useDesktopUpdater();
    const ota = useUpdates();
    const changelog = useChangelog();

    const model = React.useMemo(
        () => buildAppUpdateStatusModel({
            platformOs: Platform.OS,
            nativeUpdateUrl,
            desktop: {
                status: desktop.status,
                availableVersion: desktop.availableVersion,
                error: desktop.error,
            },
            ota: {
                isUpdatePending: ota.isUpdatePending,
            },
            changelog: {
                hasUnread: changelog.hasUnread,
            },
            t: tLoose,
        }),
        [
            changelog.hasUnread,
            desktop.availableVersion,
            desktop.error,
            desktop.status,
            nativeUpdateUrl,
            ota.isUpdatePending,
        ],
    );

    const runPrimaryAction = React.useCallback(async () => {
        if (!model.visible || model.actionDisabled) {
            return;
        }

        if (model.kind === 'native-store') {
            if (!nativeUpdateUrl) {
                return;
            }
            const supported = await Linking.canOpenURL(nativeUpdateUrl);
            if (supported) {
                await Linking.openURL(nativeUpdateUrl);
            }
            return;
        }

        if (model.kind === 'desktop') {
            if (desktop.status === 'error') {
                await desktop.refresh();
                return;
            }
            await desktop.startInstall();
            return;
        }

        if (model.kind === 'ota') {
            await ota.reloadApp();
            return;
        }

        router.push('/changelog');
        setTimeout(() => {
            changelog.markAsRead();
        }, 1000);
    }, [
        changelog,
        desktop,
        model,
        nativeUpdateUrl,
        ota,
        router,
    ]);

    const dismiss = React.useCallback(() => {
        if (!model.visible || model.kind !== 'desktop') {
            return;
        }
        desktop.dismiss();
    }, [desktop, model]);

    return {
        model,
        runPrimaryAction,
        dismiss,
    };
}
