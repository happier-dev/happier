import * as React from 'react';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { usePluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/projection';
import { t } from '@/text';

/** Inbox composes the Account availability owner; retained rows never become an enablement census. */
export function InboxPluginAvailability(props: Readonly<{
    serverId: string;
    pluginId: string;
    displayName?: string | null;
    detail?: boolean;
    children?: React.ReactNode;
}>) {
    const execution = useMountedActionExecution(props.serverId);
    const availability = usePluginAccountAvailabilityReader(execution.binding?.scope ?? null, props.pluginId);
    const disabled = availability?.readCurrentAccountEnablement(props.pluginId) === false;
    const [failure, setFailure] = React.useState<Readonly<{ code?: string }> | null>(null);
    const enable = async () => {
        setFailure(null);
        try {
            const result = await execution.execute('plugins.enable', { pluginId: props.pluginId, scope: 'account' });
            if (!result.ok) setFailure({ code: result.errorCode });
        } catch {
            setFailure({});
        }
    };
    if (!disabled) return <>{props.children}</>;
    const note = <SurfaceStateCard testID="inbox.plugin-disabled" kind="unavailable" size={props.detail ? undefined : 'line'}
        title={t('inbox.pluginDisabled', { name: props.displayName ?? t('inbox.pluginFallback') })}
        reason={failure ? t('inbox.pluginEnableFailed') : undefined} diagnosticCode={failure?.code}
        action={{ label: t('inbox.pluginTurnOn'), onPress: enable, disabled: !execution.ready }} />;
    return props.detail ? note : <>{note}{props.children}</>;
}
