import type { KnownToolDefinition } from './_types';
import { coreTaskTools } from './core/task';
import { coreTerminalTools } from './core/terminal';
import { coreSearchTools } from './core/search';
import { coreFileTools } from './core/files';
import { coreWebTools } from './core/web';
import { coreNotebookTools } from './core/notebook';
import { coreTodoTools } from './core/todo';
import { corePatchTools } from './core/patch';
import { coreDiffTools } from './core/diff';
import { coreReasoningTools } from './core/reasoning';

export const knownToolsCore = {
    ...coreTaskTools,
    ...coreTerminalTools,
    ...coreSearchTools,
    ...coreFileTools,
    ...coreWebTools,
    ...coreNotebookTools,
    ...coreTodoTools,
    ...corePatchTools,
    ...coreDiffTools,
    ...coreReasoningTools,
} satisfies Record<string, KnownToolDefinition>;
