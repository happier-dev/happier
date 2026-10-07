import * as React from 'react';
import { Button, defineUiSurface, PageHeader, Screen, ScrollArea, Select, Stack, TextField, WidgetSurface } from '@happier-dev/plugin-ui';

function Overview() {
    const [directory, setDirectory] = React.useState('.');
    const [directoryDraft, setDirectoryDraft] = React.useState(directory);
    const [filter, setFilter] = React.useState<'files' | 'folders'>('files');
    const context = React.useMemo(() => ({ directory, filter }), [directory, filter]);
    const useDirectory = () => setDirectory(directoryDraft);
    return (
        <Screen>
            <ScrollArea accessibilityLabel="Widget areas">
                <Stack gap="medium">
                    <PageHeader title="Widget areas" description="Count files or folders on the serving machine. Copies can follow this page or keep their own inputs." />
                    <TextField label="Directory on the serving machine" value={directoryDraft} onChange={setDirectoryDraft}
                        autoCapitalize="none" autoCorrect={false} required onSubmitEditing={useDirectory} />
                    <Button title="Use directory" onPress={useDirectory} />
                    <Select label="Count" presentation="segmented" value={filter}
                        options={[{ value: 'files', label: 'Files' }, { value: 'folders', label: 'Folders' }]}
                        onChange={value => { if (value === 'files' || value === 'folders') setFilter(value); }} />
                    <WidgetSurface area="pinned" context={context} title="Pinned" />
                </Stack>
            </ScrollArea>
        </Screen>
    );
}

export const renderSurface = defineUiSurface(Overview);
