import React from 'react';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useNavigation } from '@react-navigation/native';

import { DEFAULT_AGENT_ID, isAgentId, type AgentId } from '@/agents/catalog/catalog';
import { NewSessionResumeSelectionContent } from '@/components/sessions/new/components/NewSessionResumeSelectionContent';
import { setNewSessionPickerReturnParams } from '@/components/sessions/new/navigation/setNewSessionPickerReturnParams';
import { t } from '@/text';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';

export default function ResumePickerScreen() {
    const router = useRouter();
    const navigation = useNavigation();
    const params = useLocalSearchParams<{
        currentResumeId?: string;
        agentType?: AgentId;
    }>();

    const [inputValue, setInputValue] = React.useState(params.currentResumeId || '');
    const agentType: AgentId = isAgentId(params.agentType) ? params.agentType : DEFAULT_AGENT_ID;

    const handleSave = React.useCallback((nextValue: string) => {
        const returnMode = setNewSessionPickerReturnParams({
            navigation,
            router,
            routeParams: { resumeSessionId: nextValue },
        });
        if (returnMode === 'dispatch') {
            safeRouterBack({ router, navigation, fallbackHref: '/new' });
        }
    }, [navigation, router]);

    const handleClear = React.useCallback(() => {
        const returnMode = setNewSessionPickerReturnParams({
            navigation,
            router,
            routeParams: { resumeSessionId: '' },
        });
        if (returnMode === 'dispatch') {
            safeRouterBack({ router, navigation, fallbackHref: '/new' });
        }
    }, [navigation, router]);

    const headerTitle = t('newSession.resume.pickerTitle');
    const headerBackTitle = t('common.cancel');
    const screenOptions = React.useMemo(() => {
        return {
            headerShown: true,
            title: headerTitle,
            headerTitle,
            headerBackTitle,
        };
    }, [headerBackTitle, headerTitle]);

    return (
        <>
            <Stack.Screen options={screenOptions} />
            <NewSessionResumeSelectionContent
                value={inputValue}
                onChangeValue={setInputValue}
                onSave={handleSave}
                onClear={handleClear}
                onClose={() => safeRouterBack({ router, navigation, fallbackHref: '/new' })}
                agentType={agentType}
                focusMode="routeFocus"
                showInlineHeader={false}
            />
        </>
    );
}
