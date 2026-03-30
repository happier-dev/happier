import * as React from 'react';
import { View } from 'react-native';

import { ProfilesList } from '@/components/profiles/ProfilesList';
import type { AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';

import { NewSessionProfileEnvironmentVariablesPreview } from './NewSessionProfileEnvironmentVariablesPreview';

type Props = Readonly<{
    profilesListProps: React.ComponentProps<typeof ProfilesList>;
    machineId: string | null;
    serverId?: string | null;
    machineName?: string | null;
    previewDisplay: 'replace-list' | 'below-list';
    renderListContent: (profilesListProps: React.ComponentProps<typeof ProfilesList>) => React.ReactNode;
    inlinePreviewSpacingTop?: number;
}>;

export function NewSessionProfilesBrowserContent(props: Props) {
    const [previewProfile, setPreviewProfile] = React.useState<AIBackendProfile | null>(null);

    const preview = previewProfile ? (
        <NewSessionProfileEnvironmentVariablesPreview
            profile={previewProfile}
            machineId={props.machineId}
            serverId={props.serverId}
            machineName={props.machineName}
            onClose={() => setPreviewProfile(null)}
            surfaceVariant="popover"
        />
    ) : null;

    if (props.previewDisplay === 'replace-list' && preview) {
        return preview;
    }

    return (
        <>
            {props.renderListContent({
                ...props.profilesListProps,
                onViewEnvironmentVariables: (profile) => setPreviewProfile(profile),
            })}
            {props.previewDisplay === 'below-list' && preview ? (
                <View style={{ marginTop: props.inlinePreviewSpacingTop ?? 0 }}>
                    {preview}
                </View>
            ) : null}
        </>
    );
}
