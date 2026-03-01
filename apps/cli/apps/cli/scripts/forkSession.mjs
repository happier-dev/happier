#!/usr/bin/env node
// Fork a Claude session by resuming from an existing session ID.
// Usage: node apps/cli/scripts/forkSession.mjs <oldSessionId> [prompt]
// - oldSessionId: existing Claude session ID to fork from
// - prompt (optional): user prompt to feed Claude for the new fork; defaults to a generic prompt
// Outputs: New session ID and path to transcript file if successful

import { spawn } from 'child_process'
import { createInterface } from 'readline'
import path from 'path'
import os from 'os'

const args = process.argv.slice(2)
const oldSessionId = args[0]
const prompt = args[1] || 'forking this session'

if (!oldSessionId) {
  console.error('Usage: node forkSession.mjs <oldSessionId> [prompt]')
  process.exit(2)
}

console.log(`Forking Claude session from ${oldSessionId} with prompt: ${prompt}`)

const claudeArgs = [
  '--print',
  '--output-format', 'stream-json',
  '--verbose',
  '--resume', oldSessionId,
  prompt
]

const child = spawn('claude', claudeArgs, {
  stdio: ['ignore', 'pipe', 'inherit']
})

let newSessionId = null
let transcriptPath = null

const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
rl.on('line', (line) => {
  // Look for patterns emitted by Claude around session fork events
  // Example:
  // New Session ID: 1433467f-ff14-4292-b5b2-2aac77a808f0
  // Created file: ~/.claude/projects/.../1433467f-ff14-4292-b5b2-2aac77a808f0.jsonl
  const m1 = line.match(/New\s+Session\s+ID:\s*(?<id>[0-9a-f-]+)/i)
  if (m1 && m1.groups && m1.groups.id) {
    newSessionId = m1.groups.id
  }
  const m2 = line.match(/Created\s+file:\s*(?<path>.+)$/i)
  if (m2 && m2.groups && m2.groups.path) {
    transcriptPath = m2.groups.path
  }
  if (newSessionId) {
    // We could keep listening for a bit, but we have enough to report
  }
})

child.on('exit', (code, signal) => {
  if (code === 0 && newSessionId) {
    console.log(`NewSessionId: ${newSessionId}`)
    if (transcriptPath) console.log(`Transcript: ${transcriptPath}`)
    process.exit(0)
  } else {
    console.error(`Fork failed with code ${code} signal ${signal}`)
    process.exit(code !== null ? code : 1)
  }
})
