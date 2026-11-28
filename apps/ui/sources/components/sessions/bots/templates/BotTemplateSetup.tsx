import * as React from 'react';
import type { BotTemplateContentV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import type { BotTemplateSetupSelectionsV1 } from '@happier-dev/protocol/bots/templates/botTemplateActionsV1';
import { checkBotTemplateSetupReadinessV1 } from '@happier-dev/protocol/bots/templates/botTemplateOperations';
import { parseQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { resolveQualifiedConnectedAccountServiceKey } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import type { ValueRefV1 } from '@happier-dev/protocol/valueRefs/valueRefV1';
import { presentConnectSheet } from '@/components/settings/connectedServices/setup/ConnectedServiceSetupModal';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { ConnectedServiceMark } from '@/components/settings/connectedServices/ConnectedServiceMark';
import { botTemplateNeedLine } from './BotTemplatePreview';
import { t } from '@/text';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import type { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { BotTemplateSoftwareSetup } from './BotTemplateSoftwareSetup';

export const EMPTY_BOT_TEMPLATE_SETUP: BotTemplateSetupSelectionsV1 = { software: [], accounts: [], mcpServers: [] };
export const getBotTemplateSetupReadiness = checkBotTemplateSetupReadinessV1;

type ConnectionProps = Readonly<{
    needs: BotTemplateContentV1['needs'];
    value: BotTemplateSetupSelectionsV1;
    onChange(value: BotTemplateSetupSelectionsV1): void;
    scope: AccountSettingsScope | null;
}>;

export function BotTemplateSetup(props: Omit<ConnectionProps, 'scope'> & Readonly<{
    execution: ReturnType<typeof useMountedActionExecution>;
    machineId: string | null;
    machineOnline: boolean | null;
    serverId: string;
    onValidityChange?: (valid: boolean) => void;
    onInstallSummaryChange?: (summary: string) => void;
}>) {
    const changeSoftware = React.useCallback((software: BotTemplateSetupSelectionsV1['software']) => {
        props.onChange({ ...props.value, software });
    }, [props.onChange, props.value]);
    return <>
        <BotTemplateSoftwareSetup needs={props.needs.software} value={props.value.software} onChange={changeSoftware}
            execution={props.execution} machineId={props.machineId} machineOnline={props.machineOnline}
            serverId={props.serverId} onValidityChange={props.onValidityChange} onInstallSummaryChange={props.onInstallSummaryChange} />
        <BotTemplateConnectionsSetup needs={props.needs} value={props.value} onChange={props.onChange} scope={props.execution.binding?.scope ?? null} />
    </>;
}

/** Inline recipient choices; shared Connect owns account/key acquisition and no source binding is copied. */
export function BotTemplateConnectionsSetup(props: ConnectionProps) {
    const latest = React.useRef(props);
    latest.current = props;
    const setAccount = (key: string, selection: BotTemplateSetupSelectionsV1['accounts'][number]['selection']) => {
        const current = latest.current;
        current.onChange({ ...current.value, accounts: [...current.value.accounts.filter(item => item.key !== key), { key, selection }] });
    };
    const setMcp = (key: string, selection: BotTemplateSetupSelectionsV1['mcpServers'][number]['selection']) => {
        const current = latest.current;
        current.onChange({ ...current.value, mcpServers: [...current.value.mcpServers.filter(item => item.key !== key), { key, selection }] });
    };
    const bindMcpInput = (key: string, inputKey: string, value: ValueRefV1) => {
        const selected = latest.current.value.mcpServers.find(item => item.key === key)?.selection;
        setMcp(key, { action: 'bind', inputs: { ...(selected?.action === 'bind' ? selected.inputs : {}), [inputKey]: value } });
    };
    const { connectedAccounts, mcpServers, channels } = props.needs;
    // One section per kind, one row per need (lab r2 install-setupB): its name, why, and the one operation.
    // An optional need nobody connects is skipped; Create already reads it that way.
    return <>
        {channels?.length ? <ItemGroup title={t('botTemplateRecipient.conversations')} description={t('botTemplateRecipient.connectAfterCreation')}>
            {channels.map(need => <Item key={need.key} testID={`bot-template-channel-${need.key}`} title={need.name}
                subtitle={botTemplateNeedLine(need)} icon={<Icon name="send" />} mode="info" showChevron={false} />)}
        </ItemGroup> : null}
        {connectedAccounts.length ? <ItemGroup title={t('botTemplates.accounts')}>
            {connectedAccounts.map(need => {
                const connected = props.value.accounts.find(item => item.key === need.key)?.selection.action === 'connect';
                const service = parseQualifiedPluginContributionKey(resolveQualifiedConnectedAccountServiceKey(need.serviceId));
                const connect = () => {
                    if (!service) return;
                    void presentConnectSheet({ scope: props.scope, service, intent: 'link' }).then(result => {
                        if (result.kind !== 'dismissed') setAccount(need.key, { action: 'connect', binding: {
                            source: 'connected', selection: 'profile', profileId: result.account.accountId,
                        } });
                    });
                };
                return <Item key={need.key} testID={`bot-template-account-${need.key}`} title={need.name} mode="info" showChevron={false}
                    subtitle={connected ? `${t('botTemplateRecipient.connectionSelected')} · ${need.purpose}` : botTemplateNeedLine(need)}
                    icon={<ConnectedServiceMark legacyServiceId={need.serviceId} service={service} size="card" />}
                    rightElement={<RoundButton testID={`bot-template-connect-${need.key}`} size="small" display="secondary"
                        title={connected ? t('common.change') : t('botTemplateRecipient.connect')} disabled={!service} onPress={connect} />} />;
            })}
        </ItemGroup> : null}
        {mcpServers.length ? <ItemGroup title={t('botTemplates.mcp')}>
            {mcpServers.map(need => {
                const selected = props.value.mcpServers.find(item => item.key === need.key)?.selection;
                const inputs = selected?.action === 'bind' ? selected.inputs : {};
                const usable = need.definition.inputs.every(input => !input.required);
                return <React.Fragment key={need.key}>
                    <Item testID={`bot-template-mcp-${need.key}`} title={need.name} subtitle={botTemplateNeedLine(need)}
                        icon={<Icon name="plug" />} mode="info" showChevron={false}
                        rightElement={!usable ? undefined : selected?.action === 'bind'
                            ? <Icon name="check-circle" size={16} />
                            : <RoundButton testID={`bot-template-mcp-${need.key}-use`} size="small" display="secondary"
                                title={t('botTemplateRecipient.connect')} accessibilityLabel={t('botTemplateRecipient.useMcp')}
                                onPress={() => setMcp(need.key, { action: 'bind', inputs })} />} />
                    {need.definition.inputs.map(input => {
                        const value = inputs[input.key];
                        return input.secret ? <Item key={input.key} testID={`bot-template-mcp-${need.key}-${input.key}`}
                            title={input.label} subtitle={value ? t('botTemplateRecipient.keySelected') : input.purpose}
                            onPress={() => { void presentConnectSheet({ scope: props.scope, intent: 'link', service: { kind: 'key', suggestedName: input.label },
                                ...(value?.t === 'savedSecret' ? { current: value.secretId } : {}) }).then(result => {
                                if (result.kind !== 'dismissed') bindMcpInput(need.key, input.key, { t: 'savedSecret', secretId: result.secretRef });
                            }); }} /> : <Item key={input.key} title={input.label} subtitle={input.purpose} showChevron={false} accessoryLayout="adaptive"
                                rightElement={<FieldTextInput accessibilityLabel={input.label} value={value?.t === 'literal' ? value.v : ''}
                                    testID={`bot-template-mcp-${need.key}-${input.key}`} onChangeText={text => bindMcpInput(need.key, input.key, { t: 'literal', v: text })} />} />;
                    })}
                </React.Fragment>;
            })}
        </ItemGroup> : null}
    </>;
}
