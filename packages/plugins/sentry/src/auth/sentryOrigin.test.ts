import { describe, expect, it } from 'vitest';

import organizationsCloudPage from '../fixtures/organizationsCloudPage.json' with { type: 'json' };
import organizationsOssPage from '../fixtures/organizationsOssPage.json' with { type: 'json' };

import {
  checkSentryRegionUrlConsistency,
  resolveSentryCloudDeployment,
  resolveSentrySelfHostedDeployment,
} from './sentryOrigin.js';

describe('resolveSentryCloudDeployment', () => {
  it('derives only the configured Cloud us/de fixed origin and never neutral sentry.io', () => {
    expect(resolveSentryCloudDeployment('us')).toEqual({
      ok: true,
      deployment: { kind: 'cloud', region: 'us', origin: 'https://us.sentry.io' },
    });
    expect(resolveSentryCloudDeployment('de')).toEqual({
      ok: true,
      deployment: { kind: 'cloud', region: 'de', origin: 'https://de.sentry.io' },
    });
  });

  it('refuses an unconfigured or neutral region rather than falling back', () => {
    expect(resolveSentryCloudDeployment('eu')).toEqual({ ok: false, reason: 'region-unsupported' });
    expect(resolveSentryCloudDeployment('')).toEqual({ ok: false, reason: 'region-unsupported' });
    expect(resolveSentryCloudDeployment('sentry.io')).toEqual({
      ok: false,
      reason: 'region-unsupported',
    });
  });
});

describe('resolveSentrySelfHostedDeployment', () => {
  it('normalizes a pasted self-hosted URL to its canonical origin', () => {
    expect(resolveSentrySelfHostedDeployment('https://sentry.example.com/')).toEqual({
      ok: true,
      deployment: { kind: 'selfHosted', origin: 'https://sentry.example.com' },
    });
    expect(resolveSentrySelfHostedDeployment('  https://sentry.example.com  ')).toEqual({
      ok: true,
      deployment: { kind: 'selfHosted', origin: 'https://sentry.example.com' },
    });
    expect(resolveSentrySelfHostedDeployment('https://sentry.example.com:9000')).toEqual({
      ok: true,
      deployment: { kind: 'selfHosted', origin: 'https://sentry.example.com:9000' },
    });
  });

  it('rejects credentials, an unsupported scheme, a sub-path deployment and unparseable text', () => {
    expect(resolveSentrySelfHostedDeployment('https://user:secret@sentry.example.com')).toEqual({
      ok: false,
      reason: 'origin-carries-credentials',
    });
    expect(resolveSentrySelfHostedDeployment('ftp://sentry.example.com')).toEqual({
      ok: false,
      reason: 'origin-scheme-unsupported',
    });
    expect(resolveSentrySelfHostedDeployment('http://sentry.example.com')).toEqual({
      ok: false,
      reason: 'origin-scheme-unsupported',
    });
    expect(resolveSentrySelfHostedDeployment('https://sentry.example.com/sentry')).toEqual({
      ok: false,
      reason: 'origin-not-canonical',
    });
    expect(resolveSentrySelfHostedDeployment('sentry.example.com')).toEqual({
      ok: false,
      reason: 'origin-not-canonical',
    });
  });

  it('never leaks a submitted credential into the rejection result', () => {
    const rejected = resolveSentrySelfHostedDeployment('https://user:secret@sentry.example.com');
    expect(JSON.stringify(rejected)).not.toContain('secret');
  });
});

describe('checkSentryRegionUrlConsistency', () => {
  it('accepts a recorded Cloud regionUrl that equals the configured fixed origin', () => {
    const deployment = { kind: 'cloud', region: 'us', origin: 'https://us.sentry.io' } as const;
    const organization = organizationsCloudPage.body[0];

    expect(checkSentryRegionUrlConsistency(deployment, organization?.links.regionUrl))
      .toEqual({ ok: true });
  });

  it('accepts an absent regionUrl instead of replacing configuration with a response', () => {
    const deployment = { kind: 'cloud', region: 'de', origin: 'https://de.sentry.io' } as const;

    expect(checkSentryRegionUrlConsistency(deployment, undefined)).toEqual({ ok: true });
    expect(checkSentryRegionUrlConsistency(deployment, null)).toEqual({ ok: true });
  });

  it('refuses a different regionUrl rather than following it', () => {
    const deployment = { kind: 'cloud', region: 'us', origin: 'https://us.sentry.io' } as const;

    expect(checkSentryRegionUrlConsistency(deployment, 'https://de.sentry.io')).toEqual({
      ok: false,
      failure: { class: 'unsupportedContract', code: 'sentry-region-origin-undeclared' },
    });
    expect(checkSentryRegionUrlConsistency(deployment, 'https://sentry.io')).toEqual({
      ok: false,
      failure: { class: 'unsupportedContract', code: 'sentry-region-origin-undeclared' },
    });
    expect(checkSentryRegionUrlConsistency(deployment, 'not a url')).toEqual({
      ok: false,
      failure: { class: 'unsupportedContract', code: 'sentry-region-origin-undeclared' },
    });
  });

  it('applies the same consistency rule to a self-hosted deployment', () => {
    const deployment = { kind: 'selfHosted', origin: 'https://sentry.example.com' } as const;
    const organization = organizationsOssPage.body[0];

    expect(checkSentryRegionUrlConsistency(deployment, organization?.links.regionUrl))
      .toEqual({ ok: true });
    expect(checkSentryRegionUrlConsistency(deployment, 'https://other.example.com'))
      .toEqual({
        ok: false,
        failure: { class: 'unsupportedContract', code: 'sentry-region-origin-undeclared' },
      });
  });
});
