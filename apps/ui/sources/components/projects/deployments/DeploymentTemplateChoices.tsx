import * as React from 'react';
import type { DeploymentTemplateInstantiateInputV1 } from '@happier-dev/protocol/deployments/deploymentTemplateInstantiationV1';
import type { DeploymentTemplateV1 } from '@happier-dev/protocol/registries';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Switch } from '@/components/ui/forms/Switch';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { presentSavedSecretReferencePicker } from '@/components/ui/forms/valueRefs/presentSavedSecretReferencePicker';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';

type Input = DeploymentTemplateInstantiateInputV1;
export type DeploymentTemplateChoicesValue = Partial<Pick<Input, 'bindings' | 'volumeBindings' | 'domainBindings' | 'connectTo' | 'replace' | 'companions'>>;
const text = (value: DeploymentTemplateV1['title']) => typeof value === 'string' ? value : value.fallback;

/** Ephemeral reviewed template inputs. The template planner owns validation and conflict decisions. */
export function DeploymentTemplateChoices(props: Readonly<{
    template: DeploymentTemplateV1;
    lifetime: ServerAccountScopeLifetime;
    value: DeploymentTemplateChoicesValue;
    onChange: (value: DeploymentTemplateChoicesValue) => void;
    testID: string;
    services?: readonly string[];
    includeDomains?: boolean;
}>) {
    const { template, value, onChange, testID } = props;
    const [connectionsOpen, setConnectionsOpen] = React.useState(false);
    const picker = React.useRef<AbortController | null>(null);
    React.useEffect(() => () => picker.current?.abort(), []);
    const bindings = new Map(value.bindings?.map(binding => [binding.name, binding]));
    const volumeSources = new Map(value.volumeBindings?.map(binding => [binding.templateVolumeId, binding.source]));
    const domainHostnames = new Map(value.domainBindings?.map(binding => [binding.templateDomainId, binding.hostname]));
    const generated = new Set(template.generatedSecrets.map(secret => secret.key));
    const setBinding = (binding: Input['bindings'][number]) => onChange({ ...value,
        bindings: [...(value.bindings ?? []).filter(entry => entry.name !== binding.name || entry.phase !== binding.phase), binding] });
    const pickSecret = async (key: string) => {
        picker.current?.abort();
        const controller = new AbortController();
        picker.current = controller;
        const source = bindings.get(key)?.source;
        const selection = await presentSavedSecretReferencePicker({ accountLifetime: props.lifetime,
            signal: controller.signal, isCurrent: () => props.lifetime.isCurrent(), selected: source?.kind === 'secret' ? { ref: source.ref, resourceRevision: source.resourceRevision } : undefined });
        if (selection) setBinding({ purpose: 'variable', name: key, phase: 'runtime', source: { kind: 'secret', ...selection } });
    };
    const variables = template.variables.filter(variable => !variable.valueFrom);
    const exportKeys = [...new Set(Object.values(template.exports ?? {}).flatMap(output => Object.keys(output.env ?? {})))];
    const replaceKeys = [...new Set([...template.variables.map(variable => variable.key), ...exportKeys])];
    return <>
        {variables.length ? <ItemGroup title={t('projects.deployments.tabVariables')}>
            {variables.map(variable => {
                const binding = bindings.get(variable.key);
                const label = text(variable.label);
                const saved = binding?.source.kind === 'secret';
                const chooseSaved = t(saved ? 'capabilities.store.appPage.choices.savedSelected' : 'approvals.confidential.useSaved');
                return <Item key={variable.key} title={label} subtitle={variable.help ? text(variable.help) : undefined}
                    accessoryLayout="stacked" showChevron={false} rightElement={variable.secret
                        ? generated.has(variable.key) ? <SegmentedTabBar testIDPrefix={`${testID}.secret.${variable.key}`}
                            tabs={[{ id: 'generated', label: t('capabilities.store.appPage.choices.generate') },
                                { id: 'saved', label: chooseSaved }]}
                            activeTabId={saved ? 'saved' : 'generated'} labelSize="field"
                            onSelectTab={mode => { if (mode === 'saved') void pickSecret(variable.key);
                                else setBinding({ purpose: 'variable', name: variable.key, phase: 'runtime', source: { kind: 'generated', key: variable.key } }); }} />
                            : <RoundButton testID={`${testID}.secret.${variable.key}`} size="small" display="secondary"
                                title={chooseSaved} onPress={() => { void pickSecret(variable.key); }} />
                        : <FieldTextInput testID={`${testID}.variable.${variable.key}`} accessibilityLabel={label}
                            value={binding?.source.kind === 'value' ? binding.source.value : variable.default ?? ''}
                            onChangeText={value => setBinding({ purpose: 'variable', name: variable.key, phase: 'runtime', source: { kind: 'value', value } })}
                            autoCapitalize="none" />} />;
            })}
        </ItemGroup> : null}
        {template.companions?.length ? <ItemGroup header="none">
            {template.companions.map(companion => <Item key={companion.id} title={text(companion.title)}
                subtitle={companion.description ? text(companion.description) : undefined} showChevron={false}
                rightElement={<Switch testID={`${testID}.companion.${companion.id}`} value={value.companions?.includes(companion.id) ?? false}
                    onValueChange={selected => onChange({ ...value, companions: selected ? [...(value.companions ?? []), companion.id]
                        : (value.companions ?? []).filter(entry => entry !== companion.id) })} />} />)}
        </ItemGroup> : null}
        {template.volumes.length ? <ItemGroup title={t('capabilities.store.appPage.choices.volumes')}>
            {template.volumes.map(volume => <Item key={`${volume.service}:${volume.id}`} title={volume.target}
                subtitle={volume.description ? text(volume.description) : volume.service} accessoryLayout="stacked" showChevron={false}
                rightElement={<FieldTextInput testID={`${testID}.volume.${volume.id}`} accessibilityLabel={t('capabilities.store.appPage.choices.volumeName')}
                    value={volumeSources.get(volume.id) ?? ''} placeholder={volume.id}
                    onChangeText={source => onChange({ ...value, volumeBindings: [...(value.volumeBindings ?? []).filter(binding => binding.templateVolumeId !== volume.id),
                        ...(source.trim() ? [{ templateVolumeId: volume.id, source: source.trim() }] : [])] })} autoCapitalize="none" />} />)}
        </ItemGroup> : null}
        {props.includeDomains && template.domains.length ? <ItemGroup title={t('capabilities.store.appPage.addressTitle')}>
            {template.domains.map(domain => <Item key={domain.key} title={`${domain.service}:${domain.containerPort}`}
                accessoryLayout="stacked" showChevron={false} rightElement={<FieldTextInput testID={`${testID}.domain.${domain.key}`}
                    accessibilityLabel={t('capabilities.store.appPage.domainAddress')}
                    placeholder={t('capabilities.store.appPage.domainPlaceholder')}
                    value={domainHostnames.get(domain.key) ?? ''}
                    onChangeText={hostname => onChange({ ...value, domainBindings: [...(value.domainBindings ?? []).filter(binding => binding.templateDomainId !== domain.key),
                        ...(hostname.trim() ? [{ templateDomainId: domain.key, hostname: hostname.trim() }] : [])] })}
                    autoCapitalize="none" keyboardType="url" />} />)}
        </ItemGroup> : null}
        {props.services?.length && exportKeys.length ? <ItemGroup title={t('capabilities.store.appPage.choices.connect')}>
            <DropdownMenu testID={`${testID}.connectTo`} open={connectionsOpen} onOpenChange={setConnectionsOpen}
                items={[{ id: '', title: t('common.none') }, ...props.services.map(service => ({ id: service, title: service }))]}
                selectedId={value.connectTo?.service ?? ''} search
                onSelect={service => { setConnectionsOpen(false); onChange({ ...value, connectTo: service ? { service } : undefined }); }}
                itemTrigger={{ title: t('capabilities.store.appPage.choices.connect'), placeholder: t('common.none') }} />
        </ItemGroup> : null}
        {props.services && replaceKeys.length ? <ItemGroup title={t('capabilities.store.appPage.choices.replaceTitle')}
            description={t('capabilities.store.appPage.choices.replaceBody')}>
            {replaceKeys.map(key => <Item key={key} title={key} showChevron={false}
                rightElement={<Switch testID={`${testID}.replace.${key}`} value={value.replace?.includes(key) ?? false}
                    onValueChange={replace => onChange({ ...value, replace: replace ? [...(value.replace ?? []), key]
                        : (value.replace ?? []).filter(entry => entry !== key) })} />} />)}
        </ItemGroup> : null}
    </>;
}
