import React from 'react';
import { Redirect } from 'expo-router';

export default React.memo(function PromptLibraryLegacyRoute() {
    return <Redirect href={'/(app)/settings/prompts' as any} />;
});
