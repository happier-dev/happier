import { describe, expect, it } from 'vitest'
import type { SDKAssistantMessage, SDKMessage, SDKResultMessage } from '@/backends/claude/sdk'
import { MessageBuffer } from './ink/messageBuffer'
import { formatClaudeMessageForInk } from './messageFormatterInk'

function buildAssistantMessage(text: string): SDKMessage {
    return {
        type: 'assistant',
        message: {
            content: [{ type: 'text', text }],
        },
    } as unknown as SDKAssistantMessage
}

describe('formatClaudeMessageForInk', () => {
    it('renders assistant <options> blocks as a numbered list instead of raw XML', () => {
        const messageBuffer = new MessageBuffer()
        const text = 'Should I proceed?\n\n<options>\n    <option>Yes, go ahead</option>\n    <option>No, stop here</option>\n</options>'

        formatClaudeMessageForInk(buildAssistantMessage(text), messageBuffer)

        const contents = messageBuffer.getMessages().map((m) => m.content)
        expect(contents).toContain('Should I proceed?\n\nOptions:\n  1. Yes, go ahead\n  2. No, stop here')
        expect(contents.join('\n')).not.toContain('<options>')
    })

    it('leaves assistant text without options untouched', () => {
        const messageBuffer = new MessageBuffer()
        const text = 'All done. Nothing to choose here.'

        formatClaudeMessageForInk(buildAssistantMessage(text), messageBuffer)

        const contents = messageBuffer.getMessages().map((m) => m.content)
        expect(contents).toContain(text)
    })

    it('renders <options> blocks in the result summary as a numbered list', () => {
        const messageBuffer = new MessageBuffer()
        const resultMessage = {
            type: 'result',
            subtype: 'success',
            result: 'Pick a next step.\n\n<options>\n<option>Continue</option>\n<option>Abort</option>\n</options>',
        } as unknown as SDKResultMessage

        formatClaudeMessageForInk(resultMessage, messageBuffer)

        const contents = messageBuffer.getMessages().map((m) => m.content)
        expect(contents).toContain('Pick a next step.\n\nOptions:\n  1. Continue\n  2. Abort')
        expect(contents.join('\n')).not.toContain('<options>')
    })
})
