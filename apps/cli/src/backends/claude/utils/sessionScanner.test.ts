import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createSessionScanner } from './sessionScanner'
import { RawJSONLines } from '../types'
import { readClaudeTranscriptProviderActivity } from '../localControl/readClaudeTranscriptProviderActivity'
import { mkdir, writeFile, appendFile, rm, readFile, utimes, rename } from 'node:fs/promises'
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

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve
  })
  return { promise, resolve }
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

  it('fences buffered rows from the prior follower after a trusted main-session rotation', async () => {
    const firstSessionId = '31313131-3131-4313-8313-313131313131'
    const rotatedSessionId = '32323232-3232-4323-8323-323232323232'
    const firstSessionFile = join(projectDir, `${firstSessionId}.jsonl`)
    const rotatedSessionFile = join(projectDir, `${rotatedSessionId}.jsonl`)
    await writeFile(firstSessionFile, [
      JSON.stringify({
        type: 'user',
        uuid: 'first-row-before-rotation',
        sessionId: firstSessionId,
        message: { role: 'user', content: 'first row' },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'buffered-row-after-rotation',
        message: { role: 'assistant', content: [{ type: 'text', text: 'stale buffered row' }] },
      }),
    ].join('\n') + '\n')
    await writeFile(rotatedSessionFile, '')

    scanner = await createSessionScanner({
      sessionId: null,
      workingDirectory: testDir,
      bindToFirstSession: true,
      onMessage: (message) => {
        collectedMessages.push(message)
        if (message.uuid === 'first-row-before-rotation') {
          scanner?.onNewSession({
            sessionId: rotatedSessionId,
            transcriptPath: rotatedSessionFile,
          })
        }
      },
    })

    scanner.onNewSession({ sessionId: firstSessionId, transcriptPath: firstSessionFile })
    await waitFor(() => collectedMessages.length >= 1)
    await new Promise(resolve => setTimeout(resolve, 100))

    expect(collectedMessages.map((message) => message.uuid)).toEqual(['first-row-before-rotation'])
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

  it('does not abort scanning when Claude emits a uuid-less attachment row', async () => {
    scanner = await createSessionScanner({
      sessionId: null,
      workingDirectory: testDir,
      onMessage: (msg) => collectedMessages.push(msg)
    })

    const sessionId = 'uuid-less-attachment-session'
    const sessionFile = join(projectDir, `${sessionId}.jsonl`)
    await mkdir(projectDir, { recursive: true })

    await writeFile(sessionFile, [
      JSON.stringify({
        type: 'attachment',
        sessionId,
        timestamp: '2026-06-29T08:00:00.000Z',
        attachment: { type: 'agent_listing_delta', agents: [] },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-after-uuid-less-attachment',
        message: { role: 'assistant', content: [{ type: 'text', text: 'after attachment' }] },
      }),
      '',
    ].join('\n'))

    scanner.onNewSession(sessionId)

    await waitFor(() => collectedMessages.some((m) =>
      m.type === 'assistant'
      && m.message !== undefined
      && getFirstTextFromContent(m.message.content) === 'after attachment'
    ))

    expect(collectedMessages.map((m) => m.type)).toEqual(['assistant'])
  })

  it('streams Claude team inbox messages into Agent sidechains', async () => {
    const sessionId = 'session-team-inbox-1'
    const sessionFile = join(projectDir, `${sessionId}.jsonl`)

    // Claude team lives under CLAUDE_CONFIG_DIR/teams/<teamName>/inboxes/team-lead.json
    const teamName = 'happier-ui-test'
    const teamInboxDir = join(claudeConfigDir, 'teams', teamName, 'inboxes')
    await mkdir(teamInboxDir, { recursive: true })
    const leadInboxPath = join(teamInboxDir, 'team-lead.json')

    // Start with one unread message from Alpha.
    await writeFile(
      leadInboxPath,
      JSON.stringify([
        {
          from: 'Alpha',
          text: 'hello from Alpha',
          timestamp: '2026-02-28T12:00:00.000Z',
          read: false,
          color: 'blue',
        },
      ]),
      'utf-8',
    )

    scanner = await createSessionScanner({
      sessionId: null,
      workingDirectory: testDir,
      onMessage: (msg) => collectedMessages.push(msg),
    })

    // Minimal Claude JSONL to establish team + teammate spawn mapping.
    const lines: unknown[] = [
      {
        type: 'assistant',
        uuid: 'a1',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_teamcreate_1',
              name: 'AgentTeamCreate',
              input: { team_name: teamName, description: 'test' },
            },
          ],
        },
      },
      {
        type: 'assistant',
        uuid: 'a2',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_alpha_spawn_1',
              name: 'Agent',
              input: { name: 'Alpha', team_name: teamName, run_in_background: true },
            },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'u1',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_alpha_spawn_1',
              is_error: false,
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    tool_use_result: {
                      status: 'teammate_spawned',
                      agent_id: `Alpha@${teamName}`,
                      name: 'Alpha',
                      color: 'blue',
                      team_name: teamName,
                    },
                  }),
                },
              ],
            },
          ],
        },
      },
    ]

    await writeFile(sessionFile, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8')
    scanner.onNewSession(sessionId)

    await waitFor(
      () =>
        collectedMessages.some(
          (m) =>
            m.type === 'assistant' &&
            (m as any).sidechainId === 'toolu_alpha_spawn_1' &&
            (m as any).isSidechain === true,
        ),
      4000,
    )

    const sidechain = collectedMessages.find(
      (m) => m.type === 'assistant' && (m as any).sidechainId === 'toolu_alpha_spawn_1',
    ) as any
    expect(sidechain).toBeTruthy()
    expect(getFirstTextFromContent(sidechain?.message?.content)).toContain('hello from Alpha')

    const inboxAfter = JSON.parse(await readFile(leadInboxPath, 'utf-8'))
    expect(inboxAfter[0].read).toBe(true)
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

  it('skips only committed Claude JSONL keys during resume backfill', async () => {
    const altProjectDir = join(testDir, 'alt-project-committed-keys')
    await mkdir(altProjectDir, { recursive: true })

    const sessionId = '22222222-2222-2222-2222-222222222223'
    const transcriptPath = join(altProjectDir, `${sessionId}.jsonl`)

    await writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: 'assistant',
          uuid: 'already_committed',
          message: { role: 'assistant', content: [{ type: 'text', text: 'already in Happier' }] },
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'missing_during_runner_restart',
          message: { role: 'assistant', content: [{ type: 'text', text: 'missing from Happier' }] },
        }),
      ].join('\n') + '\n',
    )

    scanner = await createSessionScanner({
      sessionId,
      transcriptPath,
      workingDirectory: testDir,
      initialProcessedMessageKeys: new Set(['main:assistant:already_committed']),
      replayInitialMessages: true,
      onMessage: (msg: RawJSONLines) => collectedMessages.push(msg),
    })

    await waitFor(() => collectedMessages.length >= 1, 1000)
    expect(collectedMessages).toHaveLength(1)
    expect(collectedMessages[0].type).toBe('assistant')
    expect(collectedMessages[0].uuid).toBe('missing_during_runner_restart')
  })

  it('does not finish initial replay until asynchronous message handling is acknowledged', async () => {
    const altProjectDir = join(testDir, 'alt-project-committed-replay-ack')
    await mkdir(altProjectDir, { recursive: true })

    const sessionId = '22222222-2222-2222-2222-222222222229'
    const transcriptPath = join(altProjectDir, `${sessionId}.jsonl`)
    await writeFile(
      transcriptPath,
      JSON.stringify({
        type: 'assistant',
        uuid: 'missing_requires_ack',
        message: { role: 'assistant', content: [{ type: 'text', text: 'must commit before ready' }] },
      }) + '\n',
    )

    const replayAck = createDeferred<void>()
    let scannerReady = false
    const scannerPromise = createSessionScanner({
      sessionId,
      transcriptPath,
      workingDirectory: testDir,
      initialProcessedMessageKeys: new Set<string>(),
      replayInitialMessages: true,
      onMessage: async (_message, observation) => {
        expect(observation).toEqual({ historicalReplay: true })
        await replayAck.promise
      },
    }).then((createdScanner) => {
      scannerReady = true
      return createdScanner
    })

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(scannerReady).toBe(false)

    replayAck.resolve()
    scanner = await scannerPromise
    expect(scannerReady).toBe(true)
  })

  it('suppresses control-command XML rows in replay and live follow mode while keeping genuine user backfill', async () => {
    const altProjectDir = join(testDir, 'alt-project-command-replay')
    await mkdir(altProjectDir, { recursive: true })

    const sessionId = '22222222-2222-2222-2222-222222222224'
    const transcriptPath = join(altProjectDir, `${sessionId}.jsonl`)

    // A previous runner suppressed these controller-typed command rows WITHOUT committing them,
    // so they are absent from the committed-keys baseline and replay as "new" on every respawn.
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: 'user',
          uuid: 'cmd_replay',
          timestamp: '2026-06-11T19:02:34.665Z',
          message: {
            role: 'user',
            content: '<command-name>/effort</command-name>\n<command-message>effort</command-message>\n<command-args>medium</command-args>',
          },
        }),
        JSON.stringify({
          type: 'user',
          uuid: 'stdout_replay',
          timestamp: '2026-06-11T19:02:34.665Z',
          message: { role: 'user', content: '<local-command-stdout>Set effort level to medium</local-command-stdout>' },
        }),
        JSON.stringify({
          type: 'user',
          uuid: 'genuine_backfill',
          timestamp: '2026-06-11T19:02:35.310Z',
          message: { role: 'user', content: 'genuinely missed while the runner was down' },
        }),
      ].join('\n') + '\n',
    )

    scanner = await createSessionScanner({
      sessionId,
      transcriptPath,
      workingDirectory: testDir,
      initialProcessedMessageKeys: new Set<string>(),
      replayInitialMessages: true,
      onMessage: (msg: RawJSONLines) => collectedMessages.push(msg),
    })

    await waitFor(() => collectedMessages.length >= 1, 1000)
    expect(collectedMessages.map((m) => (m as { uuid?: string }).uuid)).toEqual(['genuine_backfill'])

    await appendFile(
      transcriptPath,
      [
        JSON.stringify({
          type: 'user',
          uuid: 'cmd_live',
          timestamp: '2026-06-11T19:05:00.000Z',
          message: {
            role: 'user',
            content: '<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>',
          },
        }),
        JSON.stringify({
          type: 'user',
          uuid: 'model_empty_args_live',
          timestamp: '2026-06-11T19:05:00.050Z',
          message: {
            role: 'user',
            content: '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>',
          },
        }),
        JSON.stringify({
          type: 'user',
          uuid: 'stdout_live',
          timestamp: '2026-06-11T19:05:00.100Z',
          message: {
            role: 'user',
            content: [
              '<local-command-stdout>Cleared conversation',
              'Additional genuine multi-line Claude local-command stdout</local-command-stdout>',
            ].join('\n'),
          },
        }),
        JSON.stringify({
          type: 'user',
          uuid: 'genuine_live',
          timestamp: '2026-06-11T19:05:00.200Z',
          message: { role: 'user', content: 'genuine live prompt' },
        }),
      ].join('\n') + '\n',
    )

    await waitFor(() => collectedMessages.length >= 2, 3000)
    expect(collectedMessages.map((m) => (m as { uuid?: string }).uuid)).toEqual(['genuine_backfill', 'genuine_live'])
  })

  it('does not replay historical JSONL rows as live rows after the followed file is replaced', async () => {
    const altProjectDir = join(testDir, 'alt-project-reset-replay')
    await mkdir(altProjectDir, { recursive: true })

    const sessionId = '22222222-2222-2222-2222-222222222225'
    const transcriptPath = join(altProjectDir, `${sessionId}.jsonl`)
    await writeFile(transcriptPath, '')

    const now = Date.now()
    scanner = await createSessionScanner({
      sessionId,
      transcriptPath,
      workingDirectory: testDir,
      onMessage: (msg: RawJSONLines) => collectedMessages.push(msg),
    })

    await appendFile(
      transcriptPath,
      JSON.stringify({
        type: 'assistant',
        uuid: 'initial-live-row',
        timestamp: new Date(now).toISOString(),
        message: { role: 'assistant', content: [{ type: 'text', text: 'initial live row' }] },
      }) + '\n',
    )
    await waitFor(() => collectedMessages.some((m) => (m as { uuid?: string }).uuid === 'initial-live-row'), 2000)

    const replacementPath = `${transcriptPath}.replacement`
    await writeFile(
      replacementPath,
      [
        JSON.stringify({
          type: 'assistant',
          uuid: 'old-row-after-replacement',
          timestamp: new Date(now - 60_000).toISOString(),
          message: { role: 'assistant', content: [{ type: 'text', text: 'old replayed row' }] },
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'fresh-row-after-replacement',
          timestamp: new Date(Date.now() + 1000).toISOString(),
          message: { role: 'assistant', content: [{ type: 'text', text: 'fresh replacement row' }] },
        }),
      ].join('\n') + '\n',
    )
    await rename(replacementPath, transcriptPath)

    await waitFor(() => collectedMessages.some((m) => (m as { uuid?: string }).uuid === 'fresh-row-after-replacement'), 4000)
    const uuids = collectedMessages.map((m) => (m as { uuid?: string }).uuid)
    expect(uuids).toContain('initial-live-row')
    expect(uuids).toContain('fresh-row-after-replacement')
    expect(uuids).not.toContain('old-row-after-replacement')
  })

  it('does not observe replay-suppressed snapshot rows on the raw side-effect channel', async () => {
    const sessionId = '22222222-2222-2222-2222-222222222226'
    const sessionFile = join(projectDir, `${sessionId}.jsonl`)
    const now = Date.now()
    await writeFile(
      sessionFile,
      [
        JSON.stringify({
          type: 'attachment',
          uuid: 'old-raw-goal-status',
          timestamp: new Date(now - 60_000).toISOString(),
          attachment: { type: 'goal_status', met: false, condition: 'old replayed goal' },
        }),
        JSON.stringify({
          type: 'attachment',
          uuid: 'raw-row-without-timestamp',
          attachment: { type: 'goal_status', met: false, condition: 'unprovably live goal' },
        }),
        JSON.stringify({
          type: 'attachment',
          uuid: 'fresh-raw-goal-status',
          timestamp: new Date(now + 1_000).toISOString(),
          attachment: { type: 'goal_status', met: false, condition: 'fresh goal' },
        }),
      ].join('\n') + '\n',
    )

    const rawValues: unknown[] = []
    scanner = await createSessionScanner({
      sessionId: null,
      workingDirectory: testDir,
      onMessage: (msg) => collectedMessages.push(msg),
      onRawJsonlValue: (value) => rawValues.push(value),
      replayInitialMessages: true,
      replaySuppressRowsBeforeMs: now - 30_000,
      bindToFirstSession: true,
    })
    scanner.onNewSession(sessionId)

    await waitFor(() => rawValues.some((value) => (value as { uuid?: string }).uuid === 'fresh-raw-goal-status'), 2000)

    const rawUuids = rawValues.map((value) => (value as { uuid?: string }).uuid)
    expect(rawUuids).toEqual(['fresh-raw-goal-status'])
  })

  it('normalizes Claude Agent Teams tool names to canonical tool names', async () => {
    scanner = await createSessionScanner({
      sessionId: null,
      workingDirectory: testDir,
      onMessage: (msg) => collectedMessages.push(msg),
    })

    const sessionId = '33333333-3333-3333-3333-333333333333'
    const sessionFile = join(projectDir, `${sessionId}.jsonl`)
    await mkdir(projectDir, { recursive: true })

    const assistantMessage = {
      type: 'assistant',
      uuid: 'a1',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tool_1', name: 'TeamCreate', input: {} },
        ],
      },
    }

    await writeFile(sessionFile, JSON.stringify(assistantMessage) + '\n')
    scanner.onNewSession(sessionId)

    await waitFor(() => collectedMessages.some((m) => m.type === 'assistant'))
    const firstAssistant = collectedMessages.find((m) => m.type === 'assistant') as any
    const content = firstAssistant?.message?.content
    expect(Array.isArray(content)).toBe(true)
    const toolUse = Array.isArray(content) ? content.find((c: any) => c?.type === 'tool_use') : null
    expect(toolUse?.name).toBe('AgentTeamCreate')
  })

  it('imports Task output_file sidechain transcript even when initial messages are pre-processed', async () => {
    const sessionId = '33333333-3333-3333-3333-333333333333'
    const sessionFile = join(projectDir, `${sessionId}.jsonl`)

    const subagentId = 'a971610'
    const sidechainId = ' toolu_task_1\n'

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
    expect(rewritten.origin).toEqual(expect.objectContaining({
      kind: 'task-notification',
      taskId: subagentId,
      toolUseId: sidechainId,
      status: 'completed',
    }))
    expect(readClaudeTranscriptProviderActivity(rewritten)).toEqual({
      type: 'task_notification',
      taskId: subagentId,
      toolUseId: sidechainId,
      terminal: true,
    })
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

  it('suppresses Claude attachment rows from visible transcript emission', async () => {
    const rawValues: unknown[] = []
    scanner = await createSessionScanner({
      sessionId: null,
      workingDirectory: testDir,
      onMessage: (msg) => collectedMessages.push(msg),
      onRawJsonlValue: (value) => rawValues.push(value),
    })

    const sessionId = '44444444-4444-4444-8444-444444444444'
    const sessionFile = join(projectDir, `${sessionId}.jsonl`)
    await writeFile(
      sessionFile,
      [
        {
          type: 'attachment',
          uuid: 'tools-delta-1',
          timestamp: new Date().toISOString(),
          sessionId,
          attachment: {
            type: 'deferred_tools_delta',
            addedNames: ['mcp__sentry_2__whoami'],
            addedLines: [],
            removedNames: [],
            readdedNames: ['mcp__sentry_2__whoami'],
            pendingMcpServers: [],
          },
        },
        {
          type: 'attachment',
          uuid: 'task-reminder-1',
          timestamp: new Date().toISOString(),
          sessionId,
          attachment: {
            type: 'task_reminder',
            content: [],
            itemCount: 0,
          },
        },
        {
          type: 'assistant',
          uuid: 'assistant-after-attachments',
          timestamp: new Date().toISOString(),
          sessionId,
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'visible assistant text' }],
          },
        },
      ].map((value) => JSON.stringify(value)).join('\n') + '\n',
    )

    scanner.onNewSession(sessionId)
    await waitFor(() => collectedMessages.some((message) => (message as any).uuid === 'assistant-after-attachments'), 3000)

    expect(rawValues.map((value) => (value as any)?.uuid)).toEqual([
      'tools-delta-1',
      'task-reminder-1',
      'assistant-after-attachments',
    ])
    expect(collectedMessages.map((message) => (message as any).uuid)).toEqual(['assistant-after-attachments'])
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

  it('never emits rows from a pre-existing sibling session that grows in a shared project dir (cross-session contamination, pid-14419)', async () => {
    const foreignSessionId = '3ea969fd-29f1-42d8-88f2-52b2696c085b'
    const boundSessionId = '8ead631a-b6ba-4559-a308-4ff8f4310b1f'
    const foreignFile = join(projectDir, `${foreignSessionId}.jsonl`)
    const boundFile = join(projectDir, `${boundSessionId}.jsonl`)

    // Foreign sibling session pre-exists at scanner start and contains an API-error
    // assistant row (which used to satisfy shouldDiscoverUnhookedSession).
    await writeFile(foreignFile, JSON.stringify({
      type: 'assistant',
      uuid: 'foreign-api-error',
      timestamp: new Date().toISOString(),
      sessionId: foreignSessionId,
      message: { role: 'assistant', content: [{ type: 'text', text: 'overloaded' }] },
      isApiErrorMessage: true,
    } as RawJSONLines) + '\n')
    await writeFile(boundFile, JSON.stringify({
      type: 'user',
      uuid: 'bound-old',
      timestamp: new Date().toISOString(),
      sessionId: boundSessionId,
      message: { content: 'bound history' },
    } as RawJSONLines) + '\n')

    // Hook-driven resume shape: scanner starts unbound with discovery on.
    scanner = await createSessionScanner({
      sessionId: null,
      workingDirectory: testDir,
      onMessage: (msg) => collectedMessages.push(msg),
      discoverNewSessions: true,
      bindToFirstSession: true,
      bindDiscoveredSessions: false,
      replayInitialMessages: true,
    })

    // The foreign session keeps running: its pre-existing file grows after scanner start.
    await appendFile(foreignFile, JSON.stringify({
      type: 'assistant',
      uuid: 'foreign-live-row',
      timestamp: new Date().toISOString(),
      sessionId: foreignSessionId,
      message: { role: 'assistant', content: [{ type: 'text', text: 'foreign answer' }] },
      isApiErrorMessage: true,
    } as RawJSONLines) + '\n')

    // The SessionStart hook arrives only after discovery has had time to run
    // (pid-14419: binding lagged ~3s behind the scanner's first discovery pass).
    await new Promise((resolve) => setTimeout(resolve, 1500))

    // SessionStart hook binds the real session; its rows must flow.
    scanner.onNewSession({ sessionId: boundSessionId, transcriptPath: boundFile })
    await appendFile(boundFile, JSON.stringify({
      type: 'assistant',
      uuid: 'bound-live-row',
      timestamp: new Date().toISOString(),
      sessionId: boundSessionId,
      message: { role: 'assistant', content: [{ type: 'text', text: 'bound answer' }] },
    } as RawJSONLines) + '\n')

    await waitFor(() => collectedMessages.some((m) => (m as any).uuid === 'bound-live-row'), 4000)
    // Give discovery interval (1s) a chance to run before asserting the negative.
    await new Promise((resolve) => setTimeout(resolve, 1200))

    const uuids = collectedMessages.map((m) => (m as any).uuid)
    expect(uuids).not.toContain('foreign-api-error')
    expect(uuids).not.toContain('foreign-live-row')
    expect(uuids).toContain('bound-live-row')
  }, 10_000)

  it('does not observe raw rows from untrusted discovered sibling sessions before binding', async () => {
    const rawValues: unknown[] = []
    const foreignSessionId = '11111111-1111-4111-8111-111111111111'
    const boundSessionId = '22222222-2222-4222-8222-222222222222'
    const foreignFile = join(projectDir, `${foreignSessionId}.jsonl`)
    const boundFile = join(projectDir, `${boundSessionId}.jsonl`)

    scanner = await createSessionScanner({
      sessionId: null,
      workingDirectory: testDir,
      onMessage: (msg) => collectedMessages.push(msg),
      onRawJsonlValue: (value) => rawValues.push(value),
      discoverNewSessions: true,
      bindToFirstSession: true,
      bindDiscoveredSessions: false,
      replayInitialMessages: true,
    })

    await writeFile(
      foreignFile,
      JSON.stringify({
        type: 'queue-operation',
        operation: 'enqueue',
        timestamp: new Date().toISOString(),
        sessionId: foreignSessionId,
        content: 'queued prompt for a different Claude session',
      }) + '\n',
    )

    await new Promise((resolve) => setTimeout(resolve, 1250))
    expect(rawValues).toHaveLength(0)

    await writeFile(
      boundFile,
      JSON.stringify({
        type: 'queue-operation',
        operation: 'enqueue',
        timestamp: new Date().toISOString(),
        sessionId: boundSessionId,
        content: 'queued prompt for this Claude session before hook binding',
      }) + '\n',
    )
    scanner.onNewSession({ sessionId: boundSessionId, transcriptPath: boundFile })

    await waitFor(() => rawValues.length > 0, 3000)
    expect(rawValues).toSatisfy((values: unknown[]) =>
      values.every((value) => {
        if (!value || typeof value !== 'object') return false
        const record = value as Record<string, unknown>
        return record.type === 'queue-operation'
          && record.operation === 'enqueue'
          && record.sessionId === boundSessionId
      }),
    )
  }, 10_000)

  it('classifies an unhooked diagnostic transcript once without replaying or following it', async () => {
    const diagnosticSessionId = '33333333-3333-4333-8333-333333333333'
    const diagnosticFile = join(projectDir, `${diagnosticSessionId}.jsonl`)
    const classifications: string[] = []

    scanner = await createSessionScanner({
      sessionId: null,
      workingDirectory: testDir,
      onMessage: (message) => collectedMessages.push(message),
      discoverNewSessions: true,
      bindToFirstSession: true,
      bindDiscoveredSessions: false,
      replayInitialMessages: true,
      classifyDiscoveredSession: ({ sessionId }) => {
        classifications.push(sessionId)
        return 'diagnostic'
      },
    })

    await writeFile(diagnosticFile,
      `${JSON.stringify({
        type: 'assistant',
        uuid: 'diagnostic-initial',
        timestamp: new Date().toISOString(),
        sessionId: diagnosticSessionId,
        message: { role: 'assistant', content: [{ type: 'text', text: 'rate limited' }] },
        isApiErrorMessage: true,
      } as RawJSONLines)}\n`,
    )

    await waitFor(() => classifications.length === 1)
    await appendFile(diagnosticFile,
      `${JSON.stringify({
        type: 'assistant',
        uuid: 'diagnostic-later',
        timestamp: new Date().toISOString(),
        sessionId: diagnosticSessionId,
        message: { role: 'assistant', content: [{ type: 'text', text: 'foreign continuation' }] },
      } as RawJSONLines)}\n`,
    )
    await new Promise((resolve) => setTimeout(resolve, 250))

    expect(classifications).toEqual([diagnosticSessionId])
    expect(collectedMessages).toHaveLength(0)
  })

  it('drops rows whose sessionId differs from the bound session (hard per-row filter)', async () => {
    const boundSessionId = '44444444-4444-4444-4444-444444444444'
    const boundFile = join(projectDir, `${boundSessionId}.jsonl`)
    await writeFile(boundFile, '')

    scanner = await createSessionScanner({
      sessionId: boundSessionId,
      transcriptPath: boundFile,
      workingDirectory: testDir,
      onMessage: (msg) => collectedMessages.push(msg),
      bindToFirstSession: true,
    })

    await appendFile(boundFile,
      JSON.stringify({
        type: 'assistant',
        uuid: 'foreign-row-in-bound-file',
        timestamp: new Date().toISOString(),
        sessionId: '55555555-5555-5555-5555-555555555555',
        message: { role: 'assistant', content: [{ type: 'text', text: 'foreign' }] },
      } as RawJSONLines) + '\n'
      + JSON.stringify({
        type: 'assistant',
        uuid: 'own-row',
        timestamp: new Date().toISOString(),
        sessionId: boundSessionId,
        message: { role: 'assistant', content: [{ type: 'text', text: 'own' }] },
      } as RawJSONLines) + '\n')

    await waitFor(() => collectedMessages.some((m) => (m as any).uuid === 'own-row'), 3000)
    expect(collectedMessages.map((m) => (m as any).uuid)).not.toContain('foreign-row-in-bound-file')
  })

  it('discovers new unhooked API-error transcripts even when filesystem mtime is older than scanner startup', async () => {
    scanner = await createSessionScanner({
      sessionId: null,
      workingDirectory: testDir,
      onMessage: (msg) => collectedMessages.push(msg),
      discoverNewSessions: true,
    })

    const sessionId = '11111111-1111-4111-8111-111111111111'
    const sessionFile = join(projectDir, `${sessionId}.jsonl`)
    await writeFile(sessionFile, `${JSON.stringify({
      type: 'assistant',
      uuid: 'assistant-auth-error-with-coarse-mtime',
      timestamp: new Date().toISOString(),
      sessionId,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Not logged in' }],
      },
      error: 'authentication_failed',
      isApiErrorMessage: true,
    } as RawJSONLines)}\n`)

    const olderThanScannerStart = new Date(Date.now() - 60_000)
    await utimes(sessionFile, olderThanScannerStart, olderThanScannerStart)

    await waitFor(() => collectedMessages.some((message) => (message as any).uuid === 'assistant-auth-error-with-coarse-mtime'), 2_500)

    expect(collectedMessages).toContainEqual(expect.objectContaining({
      uuid: 'assistant-auth-error-with-coarse-mtime',
    }))
  })

  it('does not use a fixed 1s discovery interval when watching for new sessions', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    try {
      scanner = await createSessionScanner({
        sessionId: null,
        workingDirectory: testDir,
        onMessage: (msg) => collectedMessages.push(msg),
        discoverNewSessions: true,
      })

      const intervalDelays = setIntervalSpy.mock.calls
        .map((call) => call[1])
        .filter((delay): delay is number => typeof delay === 'number');
      expect(intervalDelays).not.toContain(1_000);
    } finally {
      setIntervalSpy.mockRestore();
    }
  })

  it('discovers newly created unhooked transcripts through filesystem events without waiting for the old 1s poll', async () => {
    scanner = await createSessionScanner({
      sessionId: null,
      workingDirectory: testDir,
      onMessage: (msg) => collectedMessages.push(msg),
      discoverNewSessions: true,
    })

    const sessionId = '33333333-3333-4333-8333-333333333333'
    const sessionFile = join(projectDir, `${sessionId}.jsonl`)
    await writeFile(sessionFile, `${JSON.stringify({
      type: 'assistant',
      uuid: 'assistant-event-driven-discovery',
      timestamp: new Date().toISOString(),
      sessionId,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Connection error.' }],
      },
      error_status: 401,
    } as RawJSONLines)}\n`)

    await waitFor(
      () => collectedMessages.some((message) => (message as any).uuid === 'assistant-event-driven-discovery'),
      800,
    )

    expect(collectedMessages).toContainEqual(expect.objectContaining({
      uuid: 'assistant-event-driven-discovery',
    }))
  })

  it('discovers unhooked assistant API-error transcripts that use Claude SDK error_status', async () => {
    scanner = await createSessionScanner({
      sessionId: null,
      workingDirectory: testDir,
      onMessage: (msg) => collectedMessages.push(msg),
      discoverNewSessions: true,
    })

    const sessionId = '22222222-2222-4222-8222-222222222222'
    const sessionFile = join(projectDir, `${sessionId}.jsonl`)
    await writeFile(sessionFile, `${JSON.stringify({
      type: 'assistant',
      uuid: 'assistant-auth-error-status-only',
      timestamp: new Date().toISOString(),
      sessionId,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Connection error.' }],
      },
      error_status: 401,
    } as RawJSONLines)}\n`)

    await waitFor(() => collectedMessages.some((message) => (message as any).uuid === 'assistant-auth-error-status-only'), 2_500)

    expect(collectedMessages).toContainEqual(expect.objectContaining({
      uuid: 'assistant-auth-error-status-only',
    }))
  })
})
