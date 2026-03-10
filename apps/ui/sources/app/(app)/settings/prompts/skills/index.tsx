import React from 'react';

import { PromptLibraryEntryListScreen } from '@/components/settings/prompts/library/PromptLibraryEntryListScreen';

export default React.memo(function PromptSkillsLibraryRoute() {
    return <PromptLibraryEntryListScreen kind="bundle" />;
});
