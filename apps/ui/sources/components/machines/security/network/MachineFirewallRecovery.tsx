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
            description={t('machineDetailPage.network.savedRecoveryDescription')}>
            <SectionContentRow>
                <CodeBlockView code={JSON.stringify(props.recovery, null, 2)} language="json" showCopyButton />
            </SectionContentRow>
        </ItemGroup>
    );
}
