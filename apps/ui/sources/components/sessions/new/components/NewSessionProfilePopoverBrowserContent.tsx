import * as React from 'react';

import { ProfilesList } from '@/components/profiles/ProfilesList';

import { NewSessionProfileChipPopoverContent } from './NewSessionProfileChipPopoverContent';
import { NewSessionProfilesBrowserContent } from './NewSessionProfilesBrowserContent';

type Props = Readonly<{
    maxHeight: number;
    profilesListProps: React.ComponentProps<typeof ProfilesList>;
    machineId: string | null;
    serverId?: string | null;
    machineName?: string | null;
}>;

export function NewSessionProfilePopoverBrowserContent(props: Props) {
    return (
        <NewSessionProfilesBrowserContent
            profilesListProps={props.profilesListProps}
            machineId={props.machineId}
            serverId={props.serverId}
            machineName={props.machineName}
            previewDisplay="replace-list"
            renderListContent={(profilesListProps) => (
                <NewSessionProfileChipPopoverContent
                    maxHeight={props.maxHeight}
                    profilesListProps={profilesListProps}
                />
            )}
        />
    );
}
