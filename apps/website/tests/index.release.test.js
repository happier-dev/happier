import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const releaseIndexPath = path.resolve(here, '..', 'index.release.html')

async function readReleaseIndex() {
    return readFile(releaseIndexPath, 'utf8')
}

test('release homepage includes a first-class one-command installer for CLI (and no legacy self-host installer endpoints)', async () => {
    const html = await readReleaseIndex()

    assert.match(html, /id="self-host"/)
    assert.match(html, /curl -fsSL https:\/\/happier\.dev\/install \| bash/)
    assert.doesNotMatch(html, /https:\/\/happier\.dev\/self-host\b/)
})

test('release homepage navigation links to Get Started + Self-host (no broken how-it-works anchor)', async () => {
    const html = await readReleaseIndex()

    assert.match(html, /href="#get-started"/)
    assert.match(html, /href="#self-host"/)
    assert.doesNotMatch(html, /href="#how-it-works"/)
})
