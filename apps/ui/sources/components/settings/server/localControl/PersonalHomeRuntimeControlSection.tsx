import * as React from 'react';

import { Modal } from '@/modal';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { tLoose } from '@/text';
import { LocalRelayRuntimeControlSection } from './LocalRelayRuntimeControlSection';
import type { SystemTaskRunner } from '@/components/systemTasks/types';

/**
 * Operations are supplied by the Personal Home operation owner (Lane 07). This
 * section deliberately has no filesystem or profile-store access of its own.
 */
export type PersonalHomeRuntimeControlOperations = Readonly<{
    restart?: () => Promise<void>;
    removeProfile?: () => Promise<void>;
    uninstallRuntime?: () => Promise<void>;
    eraseData?: () => Promise<void>;
    openDataLocation?: () => Promise<void>;
    openLogs?: () => Promise<void>;
}>;

function copy(key: string, fallback: string): string {
    const translated = tLoose(`personalHome.settings.${key}`);
    return translated === `personalHome.settings.${key}` ? fallback : translated;
}

async function confirmAndRun(params: Readonly<{
    title: string;
    body: string;
    action: string;
    destructive?: boolean;
    run: () => Promise<void>;
}>): Promise<void> {
    const confirmed = await Modal.confirm(params.title, params.body, {
        confirmText: params.action,
        destructive: params.destructive === true,
    });
    if (!confirmed) return;
    try {
        await params.run();
    } catch (error) {
        await Modal.alert(tLoose('common.error'), error instanceof Error ? error.message : String(error));
    }
}

export const PersonalHomeRuntimeControlSection = React.memo(function PersonalHomeRuntimeControlSection(props: Readonly<{
    runner?: SystemTaskRunner;
    operations?: PersonalHomeRuntimeControlOperations;
    onStatusChange?: React.ComponentProps<typeof LocalRelayRuntimeControlSection>['onStatusChange'];
}>) {
    const operations = props.operations;
    return (
        <>
            <LocalRelayRuntimeControlSection
                {...(props.runner ? { runner: props.runner } : {})}
                onStatusChange={props.onStatusChange}
            />
            <ItemGroup
                title={copy('title', 'Personal Home')}
                footer={copy('footer', 'Your Home stays on this computer. These actions do not change another Home.')}
            >
                {operations?.restart ? (
                    <Item
                        testID="settings.personalHomeRuntime.restart"
                        title={copy('restartAction', 'Restart Personal Home')}
                        subtitle={copy('restartSubtitle', 'Restart the service and check its health again.')}
                        onPress={() => void operations.restart!()}
                    />
                ) : null}
                {operations?.openDataLocation ? (
                    <Item
                        testID="settings.personalHomeRuntime.openDataLocation"
                        title={copy('openDataLocationAction', 'Open Home data location')}
                        onPress={() => void operations.openDataLocation!()}
                    />
                ) : null}
                {operations?.openLogs ? (
                    <Item
                        testID="settings.personalHomeRuntime.openLogs"
                        title={copy('openLogsAction', 'Open runtime logs')}
                        onPress={() => void operations.openLogs!()}
                    />
                ) : null}
                {operations?.removeProfile ? (
                    <Item
                        testID="settings.personalHomeRuntime.removeProfile"
                        title={copy('removeProfileAction', 'Remove Home from Happier')}
                        subtitle={copy('removeProfileSubtitle', 'Removes this profile and its saved Home credential. Runtime data stays on this computer.')}
                        onPress={() => void confirmAndRun({
                            title: copy('removeProfileTitle', 'Remove Personal Home profile?'),
                            body: copy('removeProfileBody', 'This removes the profile from Happier but keeps the Personal Home runtime and its data.'),
                            action: tLoose('common.remove'),
                            destructive: true,
                            run: operations.removeProfile!,
                        })}
                        destructive
                    />
                ) : null}
                {operations?.uninstallRuntime ? (
                    <Item
                        testID="settings.personalHomeRuntime.uninstallRuntime"
                        title={copy('uninstallRuntimeAction', 'Uninstall runtime')}
                        subtitle={copy('uninstallRuntimeSubtitle', 'Removes the managed service and binaries; Home data is preserved.')}
                        onPress={() => void confirmAndRun({
                            title: copy('uninstallRuntimeTitle', 'Uninstall Personal Home runtime?'),
                            body: copy('uninstallRuntimeBody', 'The database, files, master secret, backups, and Home credential will remain on this computer.'),
                            action: tLoose('common.uninstall'),
                            destructive: true,
                            run: operations.uninstallRuntime!,
                        })}
                        destructive
                    />
                ) : null}
                {operations?.eraseData ? (
                    <Item
                        testID="settings.personalHomeRuntime.eraseData"
                        title={copy('eraseDataAction', 'Delete Personal Home data')}
                        subtitle={copy('eraseDataSubtitle', 'Permanently deletes this Home data. This cannot be undone.')}
                        onPress={() => void confirmAndRun({
                            title: copy('eraseDataTitle', 'Delete Personal Home data?'),
                            body: copy('eraseDataBody', 'This permanently deletes the Home database, files, and secret. Removing a profile or uninstalling the runtime does not do this.'),
                            action: tLoose('common.delete'),
                            destructive: true,
                            run: operations.eraseData!,
                        })}
                        destructive
                    />
                ) : null}
            </ItemGroup>
        </>
    );
});
