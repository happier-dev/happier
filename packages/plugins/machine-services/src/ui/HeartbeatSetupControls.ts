import { createElement as h, useState, type ReactElement } from 'react';
import { createHealthCheckSourceInstanceIdV1, HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1,
    HealthCheckHeartbeatConfigV1ProtocolSchema, PluginWebhookHeartbeatManageResultV1ProtocolSchema,
    type HealthCheckSetupInputV1, type HealthCheckSubjectV1 } from '@happier-dev/plugin-sdk';
import { Action, Button, Row, Stack, Text, usePluginHostApi, usePluginTranslation } from '@happier-dev/plugin-ui';
import { MACHINE_SERVICES_PLUGIN_ID } from '../healthSetup.js';

const K = 'machineServices.healthSetup.heartbeat';
type HeartbeatManagement = Readonly<{ sourceInstanceId: string; checkId: string }>;

/** The person explicitly acquires the capability URL through the guarded endpoint reader. */
export function CapabilityEndpointAddressControls(props: Readonly<{
    webhookEndpointId: string; signal: AbortSignal; title: string;
    allowGetCommand?: boolean; heartbeatManagement?: HeartbeatManagement;
}>): ReactElement {
    const host = usePluginHostApi();
    const t = usePluginTranslation();
    const [address, setAddress] = useState<string | null>(null);
    const [revision, setRevision] = useState<number | null>(null);
    const [pending, setPending] = useState(false);
    const [revoked, setRevoked] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);
    const manage = async (operation: 'status' | 'rotate' | 'revoke', expectedRevision?: number) => {
        const identity = { ...props.heartbeatManagement!, webhookEndpointId: props.webhookEndpointId };
        const input = operation === 'status' ? { ...identity, operation }
            : { ...identity, operation, expectedRevision: expectedRevision!,
                idempotencyKey: `heartbeat-${operation}-${props.webhookEndpointId}-${expectedRevision}` };
        const result = PluginWebhookHeartbeatManageResultV1ProtocolSchema.parse(await host.executeAction(
            { pluginId: MACHINE_SERVICES_PLUGIN_ID, localId: 'health/heartbeat/manage' }, input, { signal: props.signal }));
        props.signal.throwIfAborted();
        if (result.kind === 'unavailable') {
            setRevision(null);
            setNotice(result.code === 'idempotency_conflict'
                ? t(`${K}.conflict`, 'The endpoint changed. Try again to use its current revision.')
                : t(`${K}.unavailable`, 'This endpoint is unavailable. Check its observer and try again.'));
            return null;
        }
        setRevision(result.revision);
        if (result.kind === 'revoked' || result.kind === 'alreadyRevoked') {
            setRevoked(true);
            setNotice(t(`${K}.revoked`, 'Address revoked. Pings are no longer accepted.'));
        }
        return result;
    };
    const run = async (operation: 'reveal' | 'rotate' | 'revoke') => {
        setPending(true);
        setNotice(null);
        if (operation !== 'reveal') setAddress(null);
        try {
            if (operation === 'reveal') {
                const result = await host.executeAction('plugin.webhook.endpoint.read',
                    { webhookEndpointId: props.webhookEndpointId }, { signal: props.signal });
                props.signal.throwIfAborted();
                setRevision(result.revision);
                if (result.revokedAt !== undefined) {
                    setRevoked(true);
                    setNotice(t(`${K}.revoked`, 'Address revoked. Pings are no longer accepted.'));
                } else setAddress(result.publicUrl);
            } else {
                let currentRevision = revision;
                if (currentRevision === null) {
                    const current = await manage('status');
                    if (!current || current.kind === 'revoked' || current.kind === 'alreadyRevoked') return;
                    currentRevision = current.revision;
                }
                const result = await manage(operation, currentRevision);
                if (result?.kind === 'rotated') setNotice(t(`${K}.rotated`, 'Address rotated. Update your job with the new address.'));
            }
        } catch {
            if (!props.signal.aborted) setNotice(t(`${K}.failed`, 'Couldn’t manage the address. Try again.'));
        } finally {
            if (!props.signal.aborted) setPending(false);
        }
    };
    const quoted = address === null ? null : `'${address.replaceAll("'", "'\"'\"'")}'`;
    return h(Stack, { gap: 'small' },
        h(Text, { value: props.title }),
        h(Text, { tone: 'secondary', value: t(`${K}.secrecy`, 'Anyone with this address can send pings. Keep it out of logs and messages.') }),
        address === null ? null : h(Text, { variant: 'code', selectable: true, value: address }),
        revoked ? null : h(Row, { wrap: true, gap: 'small' },
            address === null ? h(Button, { title: t(`${K}.reveal`, 'Reveal address'), disabled: pending, onPress: () => run('reveal') })
                : h(Button, { title: t(`${K}.hide`, 'Hide address'), disabled: pending, variant: 'plain', onPress: () => setAddress(null) }),
            ...(address === null || quoted === null ? [] : [
                h(Action.Copy, { key: 'url', title: t(`${K}.copyUrl`, 'Copy address'), value: address, disabled: pending }),
                h(Action.Copy, { key: 'post', title: t(`${K}.copyPost`, 'Copy POST command'), value: `curl -fsS -X POST ${quoted}`, disabled: pending }),
                ...(props.allowGetCommand ? [h(Action.Copy, { key: 'get', title: t(`${K}.copyGet`, 'Copy GET command'),
                    value: `curl -fsS ${quoted}`, disabled: pending })] : []),
            ]),
            ...(props.heartbeatManagement ? [
                h(Button, { key: 'rotate', title: t(`${K}.rotate`, 'Rotate address'), disabled: pending, onPress: () => run('rotate') }),
                h(Button, { key: 'revoke', title: t(`${K}.revoke`, 'Revoke address'), disabled: pending,
                    variant: 'destructive', onPress: () => run('revoke') }),
            ] : [])),
        notice === null ? null : h(Text, { tone: 'secondary', value: notice }));
}

export function SavedHeartbeatControls(props: Readonly<{
    subject: HealthCheckSubjectV1; checks: ReadonlyArray<HealthCheckSetupInputV1['checks'][number]>; signal: AbortSignal;
}>): ReactElement | null {
    const t = usePluginTranslation();
    const sourceInstanceId = createHealthCheckSourceInstanceIdV1(props.subject);
    const controls = props.checks.flatMap(check => {
        if (check.kind.pluginId !== HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1 || check.kind.localId !== 'heartbeat') return [];
        const config = HealthCheckHeartbeatConfigV1ProtocolSchema.safeParse(check.config);
        if (!config.success || !config.data.webhookEndpointId) return [];
        return [h(CapabilityEndpointAddressControls, { key: `${sourceInstanceId}:${check.checkId}:${config.data.webhookEndpointId}`,
            webhookEndpointId: config.data.webhookEndpointId, signal: props.signal,
            title: `${t(`${K}.address`, 'Heartbeat address')} · ${check.checkId}`, allowGetCommand: true,
            heartbeatManagement: { sourceInstanceId, checkId: check.checkId } })];
    });
    return controls.length === 0 ? null : h(Stack, { gap: 'large' }, ...controls);
}
