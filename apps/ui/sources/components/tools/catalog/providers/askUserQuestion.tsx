import { createKnownToolTitle } from '../toolTitles';
import type { Metadata } from '@happier-dev/session-core/state';
import type { ToolCall } from "@happier-dev/session-core/messages";
import * as z from 'zod/mini';
import { t } from '@/text';
import { ICON_QUESTION } from '../icons';
import type { KnownToolDefinition } from '../_types';

export const providerAskUserQuestionTools = {
    'AskUserQuestion': {
        title: createKnownToolTitle("AskUserQuestion"),
        icon: ICON_QUESTION,
        minimal: false,  // Always show expanded to display options
        noStatus: true,
        input: (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.partial(z.object({
            questions: z.array(z.object({
                question: z.string().check(z.describe('The question to ask')),
                header: z.string().check(z.describe('Short label for the question')),
                options: z.array(z.object({
                    label: z.string().check(z.describe('Option label')),
                    description: z.string().check(z.describe('Option description'))
                })).check(z.describe('Available choices')),
                multiSelect: z.boolean().check(z.describe('Allow multiple selections'))
            })).check(z.describe('Questions to ask the user'))
        }))),
        extractSubtitle: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (opts.tool.input?.questions && Array.isArray(opts.tool.input.questions)) {
                const count = opts.tool.input.questions.length;
                if (count === 1) {
                    const onlyQuestion = opts.tool.input.questions[0];
                    if (typeof onlyQuestion.header === 'string' && onlyQuestion.header.trim() !== '') {
                        return onlyQuestion.header;
                    }
                    if (typeof onlyQuestion.question === 'string' && onlyQuestion.question.trim() !== '') {
                        return onlyQuestion.question;
                    }
                    return null;
                }
                return t('tools.askUserQuestion.multipleQuestions', { count });
            }
            return null;
        }
    }
} satisfies Record<string, KnownToolDefinition>;
