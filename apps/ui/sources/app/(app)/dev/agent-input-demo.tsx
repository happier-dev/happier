import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { AgentInput } from '@/components/sessions/agentInput/AgentInput';
import type { PermissionMode, ModelMode } from '@/sync/domains/permissions/permissionTypes';

export default React.memo(function AgentInputDemoScreen() {
    const [value, setValue] = React.useState('');
    const [permissionMode, setPermissionMode] = React.useState<PermissionMode>('default');
    const [modelMode, setModelMode] = React.useState<ModelMode>('default');
    const [sessionModeId, setSessionModeId] = React.useState<string | null>(null);

    return (
        <View style={styles.container}>
            <View style={styles.spacer} />
            <AgentInput
                value={value}
                placeholder="Type a message…"
                onChangeText={setValue}
                onSend={() => {}}
                autocompletePrefixes={[]}
                autocompleteSuggestions={async () => []}
                permissionMode={permissionMode}
                onPermissionModeChange={setPermissionMode}
                modelMode={modelMode}
                onModelModeChange={setModelMode}
                acpSessionModeOptionsOverride={[
                    { id: 'build', name: 'Build', description: 'Build mode' },
                    { id: 'plan', name: 'Plan', description: 'Plan mode' },
                ]}
                acpSessionModeSelectedIdOverride={sessionModeId}
                onAcpSessionModeChange={(id) => setSessionModeId(id)}
            />
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.surface,
    },
    spacer: {
        flex: 1,
    },
}));
