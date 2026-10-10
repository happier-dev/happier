import * as React from 'react';
import { createModalModuleRuntime } from '../runtime/modalRuntime';
import type { AlertButton } from '@/modal/types';

// Dialog rendering is the system boundary. The production draft hook builds
// the buttons and settles the decision; this adapter only presents/presses them.
let buttons: AlertButton[] = [];
const subscribers = new Set<() => void>();
export const { Modal } = createModalModuleRuntime({ spies: { alert: (_title, _message, next = []) => {
    buttons = next;
    subscribers.forEach(listener => listener());
} } }).module;
export const useOptionalModal = () => null;
export const useModal = () => Modal;
export const useVisibleModalKind = () => null;
export const ModalProvider = ({ children }: React.PropsWithChildren) => children;
export function DecisionDialog() {
    const current = React.useSyncExternalStore(listener => { subscribers.add(listener); return () => subscribers.delete(listener); }, () => buttons);
    return current.length ? <div id="decision">{current.map(button => <button key={button.style}
        id={button.style === 'cancel' ? 'keepEditing' : button.style === 'destructive' ? 'discard' : 'save'}
        onClick={() => { buttons = []; subscribers.forEach(listener => listener()); button.onPress?.(); }}>{button.text}</button>)}</div> : null;
}
