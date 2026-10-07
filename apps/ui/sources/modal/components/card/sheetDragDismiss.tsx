import * as React from 'react';
// RED stub: no drag dismissal yet.
export function resolveSheetDragRelease(_input: Readonly<{ translationY: number; velocityY: number; sheetHeightPx: number }>): 'dismiss' | 'settle' { return 'settle'; }
export function SheetDismissProvider(props: Readonly<{ onDismiss: () => void; children: React.ReactNode }>) { return <>{props.children}</>; }
