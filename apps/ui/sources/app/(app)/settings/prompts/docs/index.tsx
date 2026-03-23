import React from 'react';

import { PromptLibraryEntryListScreen } from '@/components/settings/prompts/library/PromptLibraryEntryListScreen';

export default React.memo(function PromptDocsLibraryRoute() {
    return <PromptLibraryEntryListScreen kind="doc" />;
});
