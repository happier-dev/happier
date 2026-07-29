import * as React from 'react';
import type { ProviderErrorV1 } from '@happier-dev/protocol';

import { ProviderErrorItems } from '@/components/settings/providers/ProviderErrorItems';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';

export function NewSessionProviderLaunchError(props: Readonly<{
    error: ProviderErrorV1 | null | undefined;
    retry?: () => void;
}>): React.ReactElement | null {
    if (!props.error) return null;

    return (
        <ItemGroup>
            <ProviderErrorItems error={props.error} retry={props.retry} />
        </ItemGroup>
    );
}
