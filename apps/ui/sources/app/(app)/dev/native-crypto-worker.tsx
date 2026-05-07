import * as React from 'react';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import {
    runNativeCryptoWorkerProbe,
    type NativeCryptoWorkerProbeReport,
} from '@/dev/nativeCryptoWorkerProbe';

const probeCheckRows = [
    ['moduleAvailable', 'Native module available', 'module-available'],
    ['batchSource', 'Native batch source', 'batch-source'],
    ['dataKey', 'Data-key vectors', 'data-key'],
    ['secretbox', 'Secretbox vectors', 'secretbox'],
    ['aesGcm', 'AES-GCM vectors', 'aes-gcm'],
    ['invalidItems', 'Invalid item isolation', 'invalid-items'],
    ['jsResponsive', 'JS responsive during call', 'js-responsive'],
] as const;

function statusTestId(status: 'pass' | 'fail' | 'running'): string {
    return `native-crypto-worker-probe-status:${status}`;
}

export default function NativeCryptoWorkerDevScreen() {
    const [report, setReport] = React.useState<NativeCryptoWorkerProbeReport | null>(null);
    const [running, setRunning] = React.useState(true);
    const [errorName, setErrorName] = React.useState<string | null>(null);

    React.useEffect(() => {
        let cancelled = false;

        runNativeCryptoWorkerProbe()
            .then((nextReport) => {
                if (cancelled) return;
                setReport(nextReport);
                console.info('[native-crypto-worker-probe]', JSON.stringify(nextReport));
            })
            .catch((error: unknown) => {
                if (cancelled) return;
                const nextErrorName = error instanceof Error ? error.name : 'UnknownError';
                setErrorName(nextErrorName);
                console.info('[native-crypto-worker-probe]', JSON.stringify({ status: 'fail', errorName: nextErrorName }));
            })
            .finally(() => {
                if (!cancelled) setRunning(false);
            });

        return () => {
            cancelled = true;
        };
    }, []);

    const status = running ? 'running' : report?.status ?? 'fail';

    return (
        <ItemList>
            <ItemGroup title="Native Crypto Worker Probe">
                <Item
                    testID={statusTestId(status)}
                    title="Probe status"
                    detail={status}
                    mode="info"
                    showChevron={false}
                />
                {errorName ? (
                    <Item
                        title="Probe error"
                        detail={errorName}
                        mode="info"
                        showChevron={false}
                    />
                ) : null}
                {report ? probeCheckRows.map(([key, title, testIdSuffix]) => {
                    const probeCheck = report.checks[key];
                    return (
                        <Item
                            key={key}
                            testID={`native-crypto-worker-probe-${testIdSuffix}:${probeCheck.status}`}
                            title={title}
                            subtitle={probeCheck.detail}
                            detail={probeCheck.status}
                            mode="info"
                            showChevron={false}
                        />
                    );
                }) : null}
            </ItemGroup>

            {report ? (
                <ItemGroup title="Runtime Evidence">
                    <Item
                        title="Native version"
                        detail={report.evidence.capability.nativeVersion?.toString() ?? 'n/a'}
                        mode="info"
                        showChevron={false}
                    />
                    <Item
                        title="Batch sources"
                        detail={report.evidence.batchSources.join(',') || 'none'}
                        mode="info"
                        showChevron={false}
                    />
                    <Item
                        title="Vector counts"
                        subtitle={`data-key ${report.evidence.dataKey.validItems}/${report.evidence.dataKey.nullItems}; secretbox ${report.evidence.secretbox.validItems}/${report.evidence.secretbox.nullItems}; aes-gcm ${report.evidence.aesGcm.validItems}/${report.evidence.aesGcm.nullItems}`}
                        mode="info"
                        showChevron={false}
                    />
                    <Item
                        title="JS responsiveness"
                        subtitle={`${report.evidence.jsResponsiveness.ticks} ticks across ${report.evidence.jsResponsiveness.batchItems} items in ${report.evidence.jsResponsiveness.elapsedMs}ms`}
                        mode="info"
                        showChevron={false}
                    />
                </ItemGroup>
            ) : null}
        </ItemList>
    );
}
