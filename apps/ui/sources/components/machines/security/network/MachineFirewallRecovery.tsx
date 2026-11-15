import * as React from 'react';
import type { MachineFirewallRecoveryV1 } from '@happier-dev/protocol/machines/adminAccessV1';
import { CodeBlockView } from '@/components/ui/code/blocks/CodeBlockView';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { t } from '@/text';

/** The native owner's exact saved state; displaying it never claims a restoration. */
export function MachineFirewallRecovery(props: Readonly<{ recovery: MachineFirewallRecoveryV1 }>) {
    return (
        <ItemGroup title={t('machineDetailPage.network.savedRecoveryTitle')}
            description={props.recovery.restore
                ? t('machineDetailPage.network.savedRecoveryBasis', { time: props.recovery.restore.capturedAt })
                : t('machineDetailPage.network.savedRecoveryDescription')}>
            <SectionContentRow>
                {props.recovery.restore ? <CodeBlockView code={props.recovery.restore.commands.join('\n')} language="shell" showCopyButton /> : null}
            </SectionContentRow>
        </ItemGroup>
    );
}
