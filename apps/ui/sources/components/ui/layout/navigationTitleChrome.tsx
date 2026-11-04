import * as React from 'react';

/**
 * Whether the surrounding navigation chrome already shows the page title (a native stack header on
 * phones). When it does, a page header shows only its purpose line so the title is never duplicated.
 */
const NavigationTitleChromeContext = React.createContext<boolean>(false);
const NavigationBackChromeShownContext = React.createContext<boolean>(false);
type NavigationTitleChromePublisher = Readonly<{
    setTitle?: (title: string | null | undefined) => void;
    /** Page identity can name its tab while phone chrome deliberately names only its kind. */
    setPageTitle?: (title: string | null | undefined) => void;
    setBack?: (back: React.ReactNode) => void;
}>;
const NavigationTitleChromePublisherContext = React.createContext<NavigationTitleChromePublisher | null>(null);

export function NavigationTitleChromeProvider(props: Readonly<{
    showsTitle: boolean;
    /** Retained deep links can have title chrome without a history Back. */
    showsBack?: boolean;
    publisher?: NavigationTitleChromePublisher;
    children: React.ReactNode;
}>) {
    return (
        <NavigationTitleChromeContext.Provider value={props.showsTitle}>
            <NavigationBackChromeShownContext.Provider value={props.showsBack ?? props.showsTitle}>
                <NavigationTitleChromePublisherContext.Provider value={props.publisher ?? null}>
                    {props.children}
                </NavigationTitleChromePublisherContext.Provider>
            </NavigationBackChromeShownContext.Provider>
        </NavigationTitleChromeContext.Provider>
    );
}

/** Retained destinations publish into their own navigation chrome, never Expo's URL mirror. */
export function useNavigationTitleChromePublisher() {
    return React.useContext(NavigationTitleChromePublisherContext);
}

/** Whether the surrounding navigation chrome already shows the page title (see `NavigationTitleChromeProvider`). */
export function useNavigationTitleChromeShowsTitle(): boolean {
    return React.useContext(NavigationTitleChromeContext);
}

export function useNavigationChromeShowsBack(): boolean {
    return React.useContext(NavigationBackChromeShownContext);
}

/**
 * The navigation chrome leaves the page's name to the page's own large title under it: a phone's top-level
 * collection page, as the Inbox tab (lab `phone-P4`). A mounted plugin page reads it as page chrome
 * (`HappierPageChromeInternal.largeTitle`), and its Collection leads with the name.
 */
const NavigationLargeTitleContext = React.createContext<boolean>(false);

export function NavigationLargeTitleProvider(props: Readonly<{ largeTitle: boolean; children: React.ReactNode }>) {
    return <NavigationLargeTitleContext.Provider value={props.largeTitle}>{props.children}</NavigationLargeTitleContext.Provider>;
}

/** Whether the surrounding navigation leaves the page's name to its large title (see `NavigationLargeTitleProvider`). */
export function useNavigationLeavesLargeTitle(): boolean {
    return React.useContext(NavigationLargeTitleContext);
}
