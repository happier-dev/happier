import { createElement } from 'react';
import { InboxModelProvider, useInboxModel } from '@/hooks/inbox/useInboxModel';
import { renderHook } from './hooks/renderHook';

export async function mountUiInboxJourney() {
    const hook = await renderHook(useInboxModel, {
        wrapper: ({ children }) => createElement(InboxModelProvider, { children }),
    });
    return { getCurrent: hook.getCurrent, unmount: hook.unmount };
}
