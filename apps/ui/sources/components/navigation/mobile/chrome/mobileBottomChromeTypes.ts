export type MobileBottomChromeModel =
    | Readonly<{ kind: 'hidden' }>
    | Readonly<{ kind: 'mainAppTabs' }>
    | Readonly<{ kind: 'detail'; pageKind: string; identity: string; activeId: string }>;
