import { describe, expect, it } from 'vitest';

import { resolveVoiceSetupHeardPhrase } from './voiceSetupHeardPhrase';

const PHRASE = 'What are my sessions doing?';

describe('resolveVoiceSetupHeardPhrase', () => {
  it('lights nothing until words are recognized', () => {
    expect(resolveVoiceSetupHeardPhrase(PHRASE, null)).toEqual({
      kind: 'phrase',
      heard: '',
      rest: PHRASE,
    });
    expect(resolveVoiceSetupHeardPhrase(PHRASE, '  ')).toEqual({
      kind: 'phrase',
      heard: '',
      rest: PHRASE,
    });
  });

  it('lights the suggested words in order as a partial transcript reaches them', () => {
    expect(resolveVoiceSetupHeardPhrase(PHRASE, 'what are my')).toEqual({
      kind: 'phrase',
      heard: 'What are my',
      rest: ' sessions doing?',
    });
    expect(
      resolveVoiceSetupHeardPhrase(PHRASE, 'Um, what are my sessions doing'),
    ).toEqual({ kind: 'phrase', heard: PHRASE, rest: '' });
  });

  it('shows the person their own words when they say something else', () => {
    expect(resolveVoiceSetupHeardPhrase(PHRASE, 'Open the review')).toEqual({
      kind: 'own',
      text: 'Open the review',
    });
  });

  it('keeps detached punctuation with the word before it', () => {
    expect(
      resolveVoiceSetupHeardPhrase(
        'Que font mes sessions ?',
        'que font mes sessions',
      ),
    ).toEqual({ kind: 'phrase', heard: 'Que font mes sessions ?', rest: '' });
  });

  it('lights the recognized prefix of a phrase written without spaces', () => {
    expect(
      resolveVoiceSetupHeardPhrase('我的会话在做什么？', '我的会话'),
    ).toEqual({ kind: 'phrase', heard: '我的会话', rest: '在做什么？' });
  });
});
