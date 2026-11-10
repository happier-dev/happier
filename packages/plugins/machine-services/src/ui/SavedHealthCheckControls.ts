import { createElement as h, useState, type ReactElement } from 'react';
import { HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1, HealthCheckKindCatalogV1ProtocolSchema,
    HealthCheckResultV1ProtocolSchema, createHealthCheckSourceInstanceIdV1,
    type HealthCheckKindCatalogV1, type HealthCheckResultV1, type HealthCheckSetupInputV1,
    type HealthCheckSubjectV1 } from '@happier-dev/plugin-sdk';
import { Button, Field, Row, Select, Stack, Text, usePluginHostApi, usePluginTranslation } from '@happier-dev/plugin-ui';
import { HEALTH_KINDS_ACTION_ID } from '../healthCatalog.js';

type Check = HealthCheckSetupInputV1['checks'][number];
const K = 'machineServices.healthSetup.saved';

/** Finite, person-requested runs use exactly the Action declared by the saved kind. */
export function SavedHealthCheckControls(props: Readonly<{ subject: HealthCheckSubjectV1;
    checks: readonly Check[]; signal: AbortSignal }>): ReactElement | null {
    const t = usePluginTranslation();
    const host = usePluginHostApi();
    const [checkId, setCheckId] = useState(props.checks[0]?.checkId ?? '');
    const [catalog, setCatalog] = useState<HealthCheckKindCatalogV1 | null>(null);
    const [busy, setBusy] = useState(false);
    const [unavailable, setUnavailable] = useState(false);
    const [settled, setSettled] = useState<Readonly<{ checkId: string; result: HealthCheckResultV1 }> | null>(null);
    if (props.checks.length === 0) return null;
    const check = props.checks.find(item => item.checkId === checkId) ?? props.checks[0]!;
    const result = settled?.checkId === check.checkId ? settled.result : null;
    const status = result?.status;
    const statusText = status === 'up' ? t(`${K}.up`, 'Up') : status === 'down' ? t(`${K}.down`, 'Down')
        : status === 'degraded' ? t(`${K}.degraded`, 'Degraded') : t(`${K}.unknown`, 'Unknown');
    return h(Stack, { gap: 'small', testID: 'health-saved-checks' },
        h(Field, { label: t(`${K}.check`, 'Saved check') }, h(Select, { label: t(`${K}.check`, 'Saved check'),
            value: check.checkId, presentation: 'field', options: props.checks.map(item => ({ value: item.checkId,
                label: item.checkId })), onChange: value => { if (typeof value === 'string') { setCheckId(value); setUnavailable(false); } } })),
        result ? h(Text, { value: statusText, tone: status === 'up' ? 'success' : status === 'down' ? 'danger' : 'secondary' }) : null,
        unavailable ? h(Text, { tone: 'secondary', value: t(`${K}.unavailable`,
            'The check could not run. Try again when its Machine is available.') }) : null,
        h(Row, { justify: 'flex-end' }, h(Button, { title: t(`${K}.run`, 'Check now'), busy, disabled: busy,
            onPress: async () => {
                setBusy(true);
                setUnavailable(false);
                try {
                    const kinds = catalog ?? HealthCheckKindCatalogV1ProtocolSchema.parse(await host.executeAction(
                        { pluginId: HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1, localId: HEALTH_KINDS_ACTION_ID }, {}, { signal: props.signal }));
                    if (props.signal.aborted) return;
                    setCatalog(kinds);
                    const kind = kinds.find(item => item.pluginId === check.kind.pluginId && item.id === check.kind.localId);
                    if (!kind) { setUnavailable(true); return; }
                    const value = await host.executeAction({ pluginId: kind.pluginId, localId: kind.action },
                        { sourceInstanceId: createHealthCheckSourceInstanceIdV1(props.subject), checkId: check.checkId },
                    { signal: props.signal });
                    if (!props.signal.aborted) setSettled({ checkId: check.checkId, result: HealthCheckResultV1ProtocolSchema.parse(value) });
                } catch {
                    if (!props.signal.aborted) setUnavailable(true);
                } finally { if (!props.signal.aborted) setBusy(false); }
            } })));
}
