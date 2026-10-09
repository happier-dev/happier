import * as React from 'react';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';
import { ShareSheet } from '../ShareSheet';
import type { ShareSheetPresentation } from '../shareSheetTypes';
import { createMachineShareAdapter } from './machineShareAdapter';
import { useMachineShareController } from './useMachineShareController';

function ScopedMachineSharingSection(props: Readonly<{
    machineId: string; machineName: string; scope: ServerAccountScope; online: boolean;
    presentation?: ShareSheetPresentation;
}>) {
    const controller = useMachineShareController(props);
    const deviceType = useDeviceType();
    const router = useRouter();
    const adapter = createMachineShareAdapter({ machineName: props.machineName, online: props.online, controller,
        openApproval: artifactId => router.push(`/inbox/approvals/${encodeURIComponent(artifactId)}?serverId=${encodeURIComponent(props.scope.serverId)}`),
    });
    return <ItemGroup title={t('machines.sharing.title')} description={t('machines.sharing.description', { machine: props.machineName })}>
        <SectionContentRow testID="machine-detail-sharing">
            <ShareSheet model={controller.model} actions={controller.actions} adapter={adapter}
                presentation={props.presentation ?? (deviceType === 'phone' ? 'full' : 'inline')} testID="machine-share-editor" />
        </SectionContentRow>
    </ItemGroup>;
}

/** The incumbent Machine page hosts the same sheet; scope changes discard no other host's state. */
export function MachineSharingSection(props: React.ComponentProps<typeof ScopedMachineSharingSection>) {
    return <ScopedMachineSharingSection key={`${props.scope.serverId}:${props.scope.accountId}:${props.machineId}`} {...props} />;
}
