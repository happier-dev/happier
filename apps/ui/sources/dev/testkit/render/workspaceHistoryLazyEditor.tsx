import * as React from 'react';
import { useUnsavedDraftNavigationGuard } from '@/utils/navigation/useUnsavedDraftNavigationGuard';
import { DecisionDialog } from './workspaceHistoryModalBoundary';
import type { DestinationNavigation } from '@/components/appShell/workspace/DestinationInstanceHost';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { PageHeaderMenu } from '@/components/ui/layout/PageHeaderEntityParts';
import { NavigationBackChromeProvider, type NavigationBackControl } from '@/components/ui/layout/NavigationBackChrome';
import { DefaultBackButton } from '@/components/navigation/Header';
import { View } from 'react-native';

const refuseSave = () => false;

export default function Editor(props: Readonly<{ navigation: DestinationNavigation }>) {
    const [draft, setDraft] = React.useState('');
    const leave = React.useCallback(() => props.navigation.canGoBack?.() ? props.navigation.back() : props.navigation.replace('/workflows'), [props.navigation]);
    const guard = useUnsavedDraftNavigationGuard({ navigation: null, isDirty: draft !== '',
        onSave: refuseSave, onLeave: leave, tag: 'lazy-workflow-editor' });
    // Match the editor body's explicit Back chrome, including on a reload/deep link.
    const backControl = React.useCallback(({ style }: React.ComponentProps<NavigationBackControl>) => <View style={style}><DefaultBackButton onPress={guard.requestBack} /></View>, [guard.requestBack]);
    return <NavigationBackChromeProvider control={backControl}><section><PageHeader title="Workflow" alwaysShowTitle actions={<PageHeaderMenu testID="history-editor-menu"
        actions={[{ id: 'discard', title: 'Discard', testID: 'history-editor-discard', onSelect: guard.requestLeave }]} />} />
        <input value={draft} onChange={event => setDraft(event.target.value)} />
        <button id="back" onClick={guard.requestBack}>Back</button>
        <DecisionDialog /></section></NavigationBackChromeProvider>;
}
