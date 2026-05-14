import * as React from 'react';

import type { ScrollItemLayoutHandler } from '@/components/ui/scroll/useScrollRectIntoView';

export type SelectionListRegisterScrollItemLayout = (optionId: string) => ScrollItemLayoutHandler;

export const SelectionListScrollIntoViewContext =
    React.createContext<SelectionListRegisterScrollItemLayout | null>(null);
