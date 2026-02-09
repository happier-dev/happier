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

test('release homepage includes first-class one-command installers for CLI and self-host', async () => {
    const html = await readReleaseIndex()

    assert.match(html, /id="self-host"/)
    assert.match(html, /curl -fsSL https:\/\/happier\.dev\/install \| bash/)
    assert.match(html, /curl -fsSL https:\/\/happier\.dev\/self-host \| bash/)
})

test('release homepage navigation links to Get Started + Self-host (no broken how-it-works anchor)', async () => {
    const html = await readReleaseIndex()

    assert.match(html, /href="#get-started"/)
    assert.match(html, /href="#self-host"/)
    assert.doesNotMatch(html, /href="#how-it-works"/)
})
