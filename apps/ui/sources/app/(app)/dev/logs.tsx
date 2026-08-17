import * as React from 'react';
import { View, Text, Pressable } from 'react-native';
import { VirtualizedList } from '@/components/ui/lists/virtualized/VirtualizedList';
import type { VirtualizedListRef } from '@/components/ui/lists/virtualized/virtualizedListTypes';
import { log } from '@/log';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Item } from '@/components/ui/lists/Item';
import { CopiedPill } from '@/components/ui/copy/CopiedPill';
import { useTemporaryCopyFeedback } from '@/components/ui/copy/useTemporaryCopyFeedback';
import { Modal } from '@/modal';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';
import { Icon } from '@/components/ui/icons/Icon';

export default function LogsScreen() {
    const [logs, setLogs] = React.useState<string[]>([]);
    const listRef = React.useRef<VirtualizedListRef>(null);
    const copyFeedback = useTemporaryCopyFeedback();

    // Subscribe to log changes
    React.useEffect(() => {
        // Add some sample logs if empty (for demo purposes)
        if (log.getCount() === 0) {
            log.log('Logger initialized');
            log.log('Sample debug message');
            log.log('Application started successfully');
        }

        // Initial load
        setLogs(log.getLogs());

        // Subscribe to changes
        const unsubscribe = log.onChange(() => {
            setLogs(log.getLogs());
        });

        return unsubscribe;
    }, []);

    // Auto-scroll to bottom when new logs arrive
    React.useEffect(() => {
        if (logs.length > 0) {
            setTimeout(() => {
                listRef.current?.scrollToEnd?.({ animated: false });
            }, 100);
        }
    }, [logs.length]);

    const handleClear = async () => {
        const confirmed = await Modal.confirm(
            'Clear Logs',
            'Are you sure you want to clear all logs?',
            { confirmText: 'Clear', destructive: true }
        );
        if (confirmed) {
            log.clear();
        }
    };

    const handleCopyAll = async () => {
        if (logs.length === 0) {
            Modal.alert('No Logs', 'There are no logs to copy');
            return;
        }

        const allLogs = logs.join('\n');
        const copied = await setClipboardStringSafe(allLogs);
        if (!copied) {
            Modal.alert('Error', 'Failed to copy logs to clipboard');
            return;
        }
        copyFeedback.markCopied('logs');
    };

    const handleAddTestLog = () => {
        const timestamp = new Date().toLocaleTimeString();
        log.log(`Test log entry at ${timestamp}`);
    };

    const renderLogItem = ({ item, index }: { item: string; index: number }) => (
        <View style={{
            paddingHorizontal: 16,
            paddingVertical: 8,
            borderBottomWidth: 1,
            borderBottomColor: '#F0F0F0'
        }}>
            <Text style={{
                fontFamily: 'IBMPlexMono-Regular',
                fontSize: 12,
                color: '#333',
                lineHeight: 16
            }}>
                {item}
            </Text>
        </View>
    );

    return (
        <View style={{ flex: 1, backgroundColor: '#F5F5F5' }}>
            {/* Header with actions */}
            <ItemList>
                <ItemGroup title={`Logs (${logs.length})`}>
                    <Item 
                        title="Add Test Log"
                        subtitle="Add a test log entry with timestamp"
                        icon={<Icon name="plus-circle" size={24} color="#34C759" />}
                        onPress={handleAddTestLog}
                    />
                    <Item 
                        title="Copy All Logs"
                        icon={<Icon name="copy" size={24} color="#007AFF" />}
                        rightElement={<CopiedPill visible={copyFeedback.isCopied('logs')} testID="dev-logs-copy-feedback" />}
                        onPress={handleCopyAll}
                        disabled={logs.length === 0}
                    />
                    <Item 
                        title="Clear All Logs"
                        icon={<Icon name="trash" size={24} color="#FF3B30" />}
                        onPress={handleClear}
                        disabled={logs.length === 0}
                        destructive={true}
                    />
                </ItemGroup>
            </ItemList>

            {/* Logs display */}
            <View style={{ flex: 1, backgroundColor: '#FFFFFF', margin: 16, borderRadius: 8 }}>
                {logs.length === 0 ? (
                    <View style={{
                        flex: 1,
                        justifyContent: 'center',
                        alignItems: 'center',
                        padding: 32
                    }}>
                        <Icon name="file-text" size={48} color="#C0C0C0" />
                        <Text style={{
                            fontSize: 16,
                            color: '#999',
                            marginTop: 16,
                            textAlign: 'center'
                        }}>
                            No logs yet
                        </Text>
                        <Text style={{
                            fontSize: 14,
                            color: '#C0C0C0',
                            marginTop: 8,
                            textAlign: 'center'
                        }}>
                            Logs will appear here as they are generated
                        </Text>
                    </View>
                ) : (
                    <VirtualizedList
                        ref={listRef}
                        data={logs}
                        renderItem={renderLogItem}
                        keyExtractor={(item, index) => index.toString()}
                        style={{ flex: 1 }}
                        contentContainerStyle={{ paddingVertical: 8 }}
                        showsVerticalScrollIndicator={true}
                    />
                )}
            </View>
        </View>
    );
}
