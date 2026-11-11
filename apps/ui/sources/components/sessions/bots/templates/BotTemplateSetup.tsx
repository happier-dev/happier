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
    return <>
        {props.needs.connectedAccounts.map(need => {
            const selected = props.value.accounts.find(item => item.key === need.key)?.selection;
            const serviceKey = resolveQualifiedConnectedAccountServiceKey(need.serviceId);
            const service = parseQualifiedPluginContributionKey(serviceKey);
            return <ItemGroup key={need.key} title={need.name} description={need.purpose}>
                <Item testID={`bot-template-connect-${need.key}`} title={t(selected?.action === 'connect' ? 'botTemplateRecipient.changeConnection' : 'botTemplateRecipient.connect')}
                    subtitle={selected?.action === 'connect' ? t('botTemplateRecipient.connectionSelected')
                        : selected?.action === 'skip' ? need.skipConsequence : t(need.requirement === 'required' ? 'botTemplateRecipient.required' : 'botTemplateRecipient.optional')}
                    disabled={!service} onPress={() => {
                        if (!service) return;
                        void presentConnectSheet({ scope: props.scope, service, intent: 'link' }).then(result => {
                            if (result.kind !== 'dismissed') setAccount(need.key, { action: 'connect', binding: {
                                source: 'connected', selection: 'profile', profileId: result.account.accountId,
                            } });
                        });
                    }} />
                {need.requirement === 'optional' ? <Item title={t('botTemplateRecipient.skipNeed')} subtitle={need.skipConsequence}
                    testID={`bot-template-skip-account-${need.key}`} onPress={() => setAccount(need.key, { action: 'skip' })} /> : null}
            </ItemGroup>;
        })}
        {props.needs.mcpServers.map(need => {
            const selected = props.value.mcpServers.find(item => item.key === need.key)?.selection;
            const inputs = selected?.action === 'bind' ? selected.inputs : {};
            return <ItemGroup key={need.key} title={need.name} description={need.purpose}>
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
                {need.definition.inputs.every(input => !input.required) ? <Item title={t('botTemplateRecipient.useMcp')} testID={`bot-template-mcp-${need.key}-use`}
                    onPress={() => setMcp(need.key, { action: 'bind', inputs })} /> : null}
                {need.requirement === 'optional' ? <Item title={t('botTemplateRecipient.skipNeed')} subtitle={need.skipConsequence}
                    testID={`bot-template-skip-mcp-${need.key}`} onPress={() => setMcp(need.key, { action: 'skip' })} /> : null}
            </ItemGroup>;
        })}
    </>;
}
