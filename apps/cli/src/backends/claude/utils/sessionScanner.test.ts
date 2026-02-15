import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createSessionScanner } from './sessionScanner'
import { RawJSONLines } from '../types'
import { mkdir, writeFile, appendFile, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { existsSync } from 'node:fs'
import { getProjectPath } from './path'

async function waitFor(predicate: () => boolean, timeoutMs: number = 2000, intervalMs: number = 25): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
  throw new Error('Timed out waiting for condition')
}

function getFirstTextFromContent(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  const first = content[0]
  if (!first || typeof first !== 'object') return null
  const text = (first as { text?: unknown }).text
  return typeof text === 'string' ? text : null
}

describe('sessionScanner', () => {
  let testDir: string
  let projectDir: string
  let collectedMessages: RawJSONLines[]
  let scanner: Awaited<ReturnType<typeof createSessionScanner>> | null = null
  let originalClaudeConfigDir: string | undefined
  let claudeConfigDir: string
  
  beforeEach(async () => {
    testDir = join(tmpdir(), `scanner-test-${Date.now()}`)
    await mkdir(testDir, { recursive: true })
    
    // Ensure the scanner and this test agree on where session files live.
    // (getProjectPath uses CLAUDE_CONFIG_DIR + a sanitized project id derived from workingDirectory.)
    originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
    claudeConfigDir = join(testDir, 'claude-config')
    process.env.CLAUDE_CONFIG_DIR = claudeConfigDir

    projectDir = getProjectPath(testDir)
    await mkdir(projectDir, { recursive: true })

    collectedMessages = []
  })
  
  afterEach(async () => {
    // Clean up scanner
    if (scanner) {
      await scanner.cleanup()
      scanner = null
    }
    
    if (originalClaudeConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
    }

    if (existsSync(testDir)) {
      await rm(testDir, { recursive: true, force: true })
    }
  })
  
  it('should process initial session and resumed session correctly', async () => {
    // TEST SCENARIO:
    // Phase 1: User says "lol" → Assistant responds "lol" → Session closes
    // Phase 2: User resumes with NEW session ID → User says "run ls tool" → Assistant runs LS tool → Shows files
    // 
    // Key point: When resuming, Claude creates a NEW session file with:
    // - Summary line
    // - Complete history from previous session (with NEW session ID)
    // - New messages
    scanner = await createSessionScanner({
      sessionId: null,
      workingDirectory: testDir,
      onMessage: (msg) => collectedMessages.push(msg)
    })
    
    // PHASE 1: Initial session (0-say-lol-session.jsonl)
    const fixture1 = await readFile(join(__dirname, '__fixtures__', '0-say-lol-session.jsonl'), 'utf-8')
    const lines1 = fixture1.split('\n').filter(line => line.trim())
    
    const sessionId1 = '93a9705e-bc6a-406d-8dce-8acc014dedbd'
    const sessionFile1 = join(projectDir, `${sessionId1}.jsonl`)
    await mkdir(projectDir, { recursive: true })
    
    // Write first line
    await writeFile(sessionFile1, lines1[0] + '\n')
    scanner.onNewSession(sessionId1)
    await waitFor(() => collectedMessages.length >= 1)
    
    expect(collectedMessages).toHaveLength(1)
    expect(collectedMessages[0].type).toBe('user')
    if (collectedMessages[0].type === 'user') {
      const content = collectedMessages[0].message.content
      const text = getFirstTextFromContent(content)
      expect(text).toBe('say lol')
    }
    
    // Write second line and wait for scanner to process it.
    await appendFile(sessionFile1, lines1[1] + '\n')
    await waitFor(() => collectedMessages.length >= 2)
    
    expect(collectedMessages).toHaveLength(2)
    expect(collectedMessages[1].type).toBe('assistant')
    if (collectedMessages[1].type === 'assistant' && collectedMessages[1].message) {
      expect(getFirstTextFromContent(collectedMessages[1].message.content)).toBe('lol')
    }
    
    // PHASE 2: Resumed session (1-continue-run-ls-tool.jsonl)
    const fixture2 = await readFile(join(__dirname, '__fixtures__', '1-continue-run-ls-tool.jsonl'), 'utf-8')
    const lines2 = fixture2.split('\n').filter(line => line.trim())
    
    const sessionId2 = '789e105f-ae33-486d-9271-0696266f072d'
    const sessionFile2 = join(projectDir, `${sessionId2}.jsonl`)
    await mkdir(projectDir, { recursive: true })
    
    // Reset collected messages count for clarity
    const phase1Count = collectedMessages.length
    
    // Write summary + historical messages (lines 0-2) - NOT line 3 which is new
    let initialContent = ''
    for (let i = 0; i <= 2; i++) {
      initialContent += lines2[i] + '\n'
    }
    await writeFile(sessionFile2, initialContent)
    
    scanner.onNewSession(sessionId2)
    await waitFor(() => collectedMessages.length >= phase1Count + 1)
    
    // Should have added only 1 new message (summary) 
    // The historical user + assistant messages (lines 1-2) are deduplicated because they have same UUIDs
    expect(collectedMessages).toHaveLength(phase1Count + 1)
    expect(collectedMessages[phase1Count].type).toBe('summary')
    
    // Write new messages (user asks for ls tool) - this is line 3
    await appendFile(sessionFile2, lines2[3] + '\n')
    await waitFor(() => collectedMessages.some(m => m.type === 'user' && m.message.content === 'run ls tool '))
    
    // Find the user message we just added
    const userMessages = collectedMessages.filter(m => m.type === 'user')
    const lastUserMsg = userMessages[userMessages.length - 1]
    expect(lastUserMsg).toBeDefined()
    if (lastUserMsg && lastUserMsg.type === 'user') {
      expect(lastUserMsg.message.content).toBe('run ls tool ')
    }
    
    // Write remaining lines (assistant tool use, tool result, final assistant message) - starting from line 4
    for (let i = 4; i < lines2.length; i++) {
      await appendFile(sessionFile2, lines2[i] + '\n')
    }
    await waitFor(
      () =>
        collectedMessages.some((m) => {
          if (m.type !== 'assistant') return false
          const text = getFirstTextFromContent(m.message?.content)
          return typeof text === 'string' && text.includes('0-say-lol-session.jsonl')
        }),
      5000,
    )
    
    // Final count check
    const finalMessages = collectedMessages.slice(phase1Count)
    
    // Should have: 1 summary + 0 history (deduplicated) + 4 new messages = 5 total for session 2
    expect(finalMessages.length).toBeGreaterThanOrEqual(5)
    
    // Verify last message is assistant with the file listing
    const lastAssistantMsg = collectedMessages[collectedMessages.length - 1]
    expect(lastAssistantMsg.type).toBe('assistant')
    if (lastAssistantMsg.type === 'assistant' && lastAssistantMsg.message?.content) {
      const content = getFirstTextFromContent(lastAssistantMsg.message.content) ?? ''
      expect(content).toContain('0-say-lol-session.jsonl')
      expect(content).toContain('readme.md')
    }
  })

  it('should read from transcriptPath when provided (even if projectDir differs)', async () => {
    scanner = await createSessionScanner({
      sessionId: null,
      workingDirectory: testDir,
      onMessage: (msg) => collectedMessages.push(msg)
    })

    const altProjectDir = join(testDir, 'alt-project')
    await mkdir(altProjectDir, { recursive: true })

    const sessionId = '11111111-1111-1111-1111-111111111111'
    const transcriptPath = join(altProjectDir, `${sessionId}.jsonl`)
    await writeFile(transcriptPath, JSON.stringify({
      type: 'user',
      uuid: 'm1',
      message: { content: 'hello from alt dir' }
    }) + '\n')

    if (!scanner) throw new Error('scanner is not initialized')
    scanner.onNewSession({ sessionId, transcriptPath })

    await waitFor(() => collectedMessages.length >= 1, 500)

    expect(collectedMessages).toHaveLength(1)
    expect(collectedMessages[0].type).toBe('user')
    if (collectedMessages[0].type === 'user') {
      expect(collectedMessages[0].message.content).toBe('hello from alt dir')
    }
  })

  it('should use initial transcriptPath to mark existing messages as processed', async () => {
    const altProjectDir = join(testDir, 'alt-project')
    await mkdir(altProjectDir, { recursive: true })

    const sessionId = '22222222-2222-2222-2222-222222222222'
    const transcriptPath = join(altProjectDir, `${sessionId}.jsonl`)

    // Existing message should be treated as already-processed (not emitted)
    await writeFile(
      transcriptPath,
      JSON.stringify({
        type: 'user',
        uuid: 'm_old',
        message: { content: 'old message' },
      }) + '\n',
    )

    scanner = await createSessionScanner({
      sessionId,
      transcriptPath,
      workingDirectory: testDir,
      onMessage: (msg: RawJSONLines) => collectedMessages.push(msg),
    })

    // Should not emit existing history on startup
    expect(collectedMessages).toHaveLength(0)

    // Append new message and ensure it is emitted
    await appendFile(
      transcriptPath,
      JSON.stringify({
        type: 'assistant',
        uuid: 'm_new',
        message: {},
      }) + '\n',
    )

    await waitFor(() => collectedMessages.length >= 1, 1000)
    expect(collectedMessages).toHaveLength(1)
    expect(collectedMessages[0].type).toBe('assistant')
  })

  it('imports Task output_file sidechain transcript even when initial messages are pre-processed', async () => {
    const sessionId = '33333333-3333-3333-3333-333333333333'
    const sessionFile = join(projectDir, `${sessionId}.jsonl`)

    const subagentId = 'a971610'
    const sidechainId = 'toolu_task_1'

    const subagentsDir = join(projectDir, sessionId, 'subagents')
    await mkdir(subagentsDir, { recursive: true })
    const subagentJsonlPath = join(subagentsDir, `agent-${subagentId}.jsonl`)

    // First line is the prompt root (should be skipped by importer), second line is actual content.
    const subagentLines = [
      JSON.stringify({
        parentUuid: null,
        isSidechain: true,
        type: 'user',
        agentId: subagentId,
        uuid: 'sc_root',
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: 'prompt root' },
      }),
      JSON.stringify({
        parentUuid: 'sc_root',
        isSidechain: true,
        type: 'assistant',
        agentId: subagentId,
        uuid: 'sc_msg_1',
        timestamp: new Date().toISOString(),
        message: { role: 'assistant', content: [{ type: 'text', text: 'Working...' }] },
      }),
    ]
    await writeFile(subagentJsonlPath, subagentLines.join('\n') + '\n')

    const tasksDir = join(testDir, 'tasks')
    await mkdir(tasksDir, { recursive: true })
    const outputFilePath = join(tasksDir, `${subagentId}.output`)
    // Make output_file a symlink, matching Claude Code behavior.
    await (await import('node:fs/promises')).symlink(subagentJsonlPath, outputFilePath)

    const assistantToolUse = {
      type: 'assistant',
      uuid: 'a1',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: sidechainId,
            name: 'Task',
            input: { description: 'Count tests', prompt: 'count', run_in_background: true },
          },
        ],
      },
    }

    const userToolResult = {
      type: 'user',
      uuid: 'u1',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: sidechainId,
            content: [
              {
                type: 'text',
                text:
                  `Async agent launched successfully.\n` +
                  `agentId: ${subagentId}\n` +
                  `output_file: ${outputFilePath}\n`,
              },
            ],
          },
        ],
      },
      toolUseResult: {
        status: 'async_launched',
        agentId: subagentId,
        outputFile: outputFilePath,
      },
    }

    await writeFile(sessionFile, JSON.stringify(assistantToolUse) + '\n' + JSON.stringify(userToolResult) + '\n')

    scanner = await createSessionScanner({
      sessionId,
      workingDirectory: testDir,
      onMessage: (msg) => collectedMessages.push(msg),
    })

    await waitFor(
      () => collectedMessages.some((m) => (m as any).isSidechain === true && (m as any).sidechainId === sidechainId),
      2000,
    )

    // Ensure we did not replay the pre-existing main session history.
    expect(collectedMessages.some((m) => (m as any).uuid === 'a1')).toBe(false)
    expect(collectedMessages.some((m) => (m as any).uuid === 'u1')).toBe(false)

    const sidechainMsg = collectedMessages.find((m) => (m as any).sidechainId === sidechainId)
    expect(sidechainMsg).toBeDefined()
    expect((sidechainMsg as any).isSidechain).toBe(true)
    expect((sidechainMsg as any).sidechainId).toBe(sidechainId)
  })

  it('imports Task sidechain transcript from inferred subagent jsonl path when output_file is missing', async () => {
    const sessionId = '55555555-5555-5555-5555-555555555555'
    const sessionFile = join(projectDir, `${sessionId}.jsonl`)

    const agentId = 'a6ca4a6'
    const sidechainId = 'toolu_task_3'

    const subagentsDir = join(projectDir, sessionId, 'subagents')
    await mkdir(subagentsDir, { recursive: true })
    const subagentJsonlPath = join(subagentsDir, `agent-${agentId}.jsonl`)

    const subagentLines = [
      JSON.stringify({
        parentUuid: null,
        isSidechain: true,
        type: 'user',
        agentId,
        uuid: 'sc2_root',
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: 'prompt root' },
      }),
      JSON.stringify({
        parentUuid: 'sc2_root',
        isSidechain: true,
        type: 'assistant',
        agentId,
        uuid: 'sc2_msg_1',
        timestamp: new Date().toISOString(),
        message: { role: 'assistant', content: [{ type: 'text', text: 'Subagent says hi' }] },
      }),
    ]
    await writeFile(subagentJsonlPath, subagentLines.join('\n') + '\n')

    const assistantToolUse = {
      type: 'assistant',
      uuid: 'a3',
      sessionId,
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: sidechainId,
            name: 'Task',
            input: { description: 'Explore', prompt: 'explore' },
          },
        ],
      },
    }

    const userToolResult = {
      type: 'user',
      uuid: 'u4',
      sessionId,
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: sidechainId,
            content: [{ type: 'text', text: `done\nagentId: ${agentId}\n` }],
          },
        ],
      },
      toolUseResult: {
        status: 'completed',
        agentId,
      },
    }

    await writeFile(sessionFile, JSON.stringify(assistantToolUse) + '\n' + JSON.stringify(userToolResult) + '\n')

    scanner = await createSessionScanner({
      sessionId,
      workingDirectory: testDir,
      onMessage: (msg) => collectedMessages.push(msg),
    })

    await waitFor(
      () => collectedMessages.some((m) => (m as any).isSidechain === true && (m as any).sidechainId === sidechainId),
      2000,
    )

    const sidechainMsg = collectedMessages.find((m) => (m as any).sidechainId === sidechainId)
    expect(sidechainMsg).toBeDefined()
    expect((sidechainMsg as any).isSidechain).toBe(true)
    expect((sidechainMsg as any).sidechainId).toBe(sidechainId)
  })

  it('rewrites <task-notification> user text into a Task tool_result update (and does not emit the raw XML)', async () => {
    scanner = await createSessionScanner({
      sessionId: null,
      workingDirectory: testDir,
      onMessage: (msg) => collectedMessages.push(msg),
    })

    const sessionId = '44444444-4444-4444-4444-444444444444'
    const sessionFile = join(projectDir, `${sessionId}.jsonl`)

    const subagentId = 'ab0e58d'
    const sidechainId = 'toolu_task_2'
    const outputFilePath = join(testDir, 'tasks', `${subagentId}.output`)
    await mkdir(join(testDir, 'tasks'), { recursive: true })
    await writeFile(outputFilePath, 'placeholder\n')

    const assistantToolUse = {
      type: 'assistant',
      uuid: 'a2',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: sidechainId,
            name: 'Task',
            input: { description: 'Explore', prompt: 'explore', run_in_background: true },
          },
        ],
      },
    }

    const userToolResult = {
      type: 'user',
      uuid: 'u2',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: sidechainId,
            content: [
              {
                type: 'text',
                text:
                  `Async agent launched successfully.\n` +
                  `agentId: ${subagentId}\n` +
                  `output_file: ${outputFilePath}\n`,
              },
            ],
          },
        ],
      },
      toolUseResult: {
        status: 'async_launched',
        agentId: subagentId,
        outputFile: outputFilePath,
      },
    }

    const taskNotification = {
      type: 'user',
      uuid: 'u3',
      message: {
        role: 'user',
        content:
          '<task-notification>\n' +
          `<task-id>${subagentId}</task-id>\n` +
          '<status>completed</status>\n' +
          '<summary>done</summary>\n' +
          '<result>Hello from task</result>\n' +
          '</task-notification>\n' +
          `Full transcript available at: ${outputFilePath}`,
      },
    }

    await writeFile(
      sessionFile,
      [assistantToolUse, userToolResult, taskNotification].map((v) => JSON.stringify(v)).join('\n') + '\n',
    )

    if (!scanner) throw new Error('scanner not initialized')
    scanner.onNewSession(sessionId)

    await waitFor(
      () =>
        collectedMessages.some(
          (m) =>
            m.type === 'user' &&
            Array.isArray((m as any).message?.content) &&
            (m as any).message.content.some((c: any) => c?.type === 'tool_result' && c?.tool_use_id === sidechainId),
        ),
      2000,
    )

    expect(
      collectedMessages.some(
        (m) => m.type === 'user' && typeof (m as any).message?.content === 'string' && String((m as any).message.content).includes('<task-notification>'),
      ),
    ).toBe(false)

    const rewritten = collectedMessages.find(
      (m) =>
        (m as any).uuid === 'u3' &&
        m.type === 'user' &&
        Array.isArray((m as any).message?.content) &&
        (m as any).message.content.some((c: any) => c?.type === 'tool_result' && c?.tool_use_id === sidechainId),
    ) as any
    expect(rewritten).toBeTruthy()
    const toolResult = rewritten.message.content.find((c: any) => c?.type === 'tool_result' && c?.tool_use_id === sidechainId)
    expect(toolResult).toBeTruthy()
    const text = getFirstTextFromContent(toolResult.content)
    expect(text).toContain('Hello from task')
  })

  it('should emit progress records from transcript files', async () => {
    scanner = await createSessionScanner({
      sessionId: null,
      workingDirectory: testDir,
      onMessage: (msg) => collectedMessages.push(msg),
    })

    const sessionId = '33333333-3333-3333-3333-333333333333'
    const sessionFile = join(projectDir, `${sessionId}.jsonl`)
    await writeFile(
      sessionFile,
      JSON.stringify({
        type: 'progress',
        uuid: 'progress-1',
        status: 'running',
      }) + '\n',
    )

    scanner.onNewSession(sessionId)
    await waitFor(() => collectedMessages.length >= 1, 1000)

    expect(collectedMessages).toHaveLength(1)
    expect(collectedMessages[0].type).toBe('progress')
    expect((collectedMessages[0] as any).uuid).toBe('progress-1')
  })
  
  it('should notify when transcript file is missing for too long', async () => {
    const missing: { sessionId: string; filePath: string }[] = []

    scanner = await createSessionScanner({
      sessionId: null,
      workingDirectory: testDir,
      onMessage: (msg) => collectedMessages.push(msg),
      onTranscriptMissing: (info: { sessionId: string; filePath: string }) => missing.push(info),
      transcriptMissingWarningMs: 50,
    })

    const sessionId = '11111111-1111-1111-1111-111111111111'
    scanner.onNewSession(sessionId)

    await waitFor(() => missing.length >= 1)

    expect(missing).toEqual([
      { sessionId, filePath: join(projectDir, `${sessionId}.jsonl`) },
    ])
  })
})
