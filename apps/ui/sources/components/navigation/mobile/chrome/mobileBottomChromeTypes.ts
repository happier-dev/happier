export type MobileBottomChromeModel =
    | Readonly<{ kind: 'hidden' }>
    | Readonly<{ kind: 'mainAppTabs' }>
    /** A page whose detail host draws its own bar, before that host has mounted: the bar will stand here. */
    | Readonly<{ kind: 'detailPending' }>
    | Readonly<{ kind: 'detail'; pageKind: string; identity: string; activeId: string }>;
