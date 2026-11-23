import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { GithubCallbackSpecimen } from '@/components/dev/homeSignIn/GithubCallbackSpecimen';

/** Dev-only: the GitHub sign-in row's callback address. `?viewer=edit|view&callback=unset|set`. */
export default function GithubCallbackDevScreen() {
    const params = useLocalSearchParams<{ viewer?: string; callback?: string }>();
    return (
        <GithubCallbackSpecimen
            viewer={params.viewer === 'view' ? 'view' : 'edit'}
            callback={params.callback === 'set' ? 'set' : 'unset'}
        />
    );
}
