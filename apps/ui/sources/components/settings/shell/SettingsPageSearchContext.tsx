import * as React from 'react';

export type SettingsPageSearchQuery = readonly [string, React.Dispatch<React.SetStateAction<string>>];

const SettingsPageSearchContext = React.createContext<SettingsPageSearchQuery | null>(null);

export function useSettingsPageSearchQuery(): SettingsPageSearchQuery {
    const query = React.useContext(SettingsPageSearchContext);
    if (!query) throw new Error('Settings page search requires its Settings shell');
    return query;
}

/** The Settings layout keeps the page query while its selected leaf is replaced. */
export function SettingsPageSearchProvider(props: Readonly<{ children: React.ReactNode }>) {
    const [query, setQuery] = React.useState('');
    const value = React.useMemo(() => [query, setQuery] as const, [query]);
    return <SettingsPageSearchContext.Provider value={value}>
        {props.children}
    </SettingsPageSearchContext.Provider>;
}
