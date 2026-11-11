import * as React from 'react';
import { storeKinds, type StoreDemand, type StoreKind, type StoreListInput } from './catalog/storeKinds';

export type StoreKindList<Kind extends StoreKind> = ReturnType<(typeof storeKinds)[Kind]['useList']>;
type KindProps<Kind extends StoreKind> = Readonly<{
    input: StoreListInput;
    demand: StoreDemand;
    children: (list: StoreKindList<Kind>) => React.ReactNode;
}>;

// Fixed, module-scope leaves keep hook order independent of the selected kind.
// S40-UI supplies the shared Collection/page composition through children.
export function StoreAppKind(props: KindProps<'app'>): React.ReactNode {
    return props.children(storeKinds.app.useList(props.input, props.demand));
}
export function StoreStarterKind(props: KindProps<'starter'>): React.ReactNode {
    return props.children(storeKinds.starter.useList(props.input, props.demand));
}
export function StoreBrowserExtensionKind(props: KindProps<'browserExtension'>): React.ReactNode {
    return props.children(storeKinds.browserExtension.useList(props.input, props.demand));
}
export function StoreMcpKind(props: KindProps<'mcpServer'>): React.ReactNode {
    return props.children(storeKinds.mcpServer.useList(props.input, props.demand));
}
export function StoreSkillKind(props: KindProps<'skill'>): React.ReactNode {
    return props.children(storeKinds.skill.useList(props.input, props.demand));
}
export function StoreAgentKind(props: KindProps<'agent'>): React.ReactNode {
    return props.children(storeKinds.agent.useList(props.input, props.demand));
}
export function StoreProviderKind(props: KindProps<'provider'>): React.ReactNode {
    return props.children(storeKinds.provider.useList(props.input, props.demand));
}
export function StorePluginKind(props: KindProps<'plugin'>): React.ReactNode {
    return props.children(storeKinds.plugin.useList(props.input, props.demand));
}
export function StoreSoftwareKind(props: KindProps<'software'>): React.ReactNode {
    return props.children(storeKinds.software.useList(props.input, props.demand));
}

type StoreKindScreenProps = { [Kind in StoreKind]: KindProps<Kind> & Readonly<{ kind: Kind }> }[StoreKind];
export function StoreKindScreen(props: StoreKindScreenProps): React.ReactNode {
    switch (props.kind) {
        case 'app': return <StoreAppKind {...props} />;
        case 'starter': return <StoreStarterKind {...props} />;
        case 'browserExtension': return <StoreBrowserExtensionKind {...props} />;
        case 'mcpServer': return <StoreMcpKind {...props} />;
        case 'skill': return <StoreSkillKind {...props} />;
        case 'agent': return <StoreAgentKind {...props} />;
        case 'provider': return <StoreProviderKind {...props} />;
        case 'plugin': return <StorePluginKind {...props} />;
        case 'software': return <StoreSoftwareKind {...props} />;
    }
}
