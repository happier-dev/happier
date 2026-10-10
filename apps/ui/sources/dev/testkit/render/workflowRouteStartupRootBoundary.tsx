import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { WorkspaceBrowserPresentation } from './WorkspaceBrowserPresentation';

let rootComponent: React.ComponentType | null = null;

// OS root-registration boundary only. The real index, qualified Expo entry,
// generated context, linking and production layouts execute unchanged.
export function renderRootComponent(component: React.ComponentType): void {
    rootComponent = component;
}

export function mountStartupRoot(): void {
    if (!rootComponent) throw new Error('The production entry did not register its root');
    const Component = rootComponent;
    createRoot(document.getElementById('root')!).render(<WorkspaceBrowserPresentation>
        <Component />
    </WorkspaceBrowserPresentation>);
}
