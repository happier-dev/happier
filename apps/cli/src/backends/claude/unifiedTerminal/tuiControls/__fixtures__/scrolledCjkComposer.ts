// Live capture 2026-11-20 (Claude Code 2.1.329, `"tui": "fullscreen"`, detached tmux 80x24): a
// 270-character Chinese prompt without line breaks. CJK rows wrap without a space at the break, and a
// full-width comma that no longer fits on a row opens the next one.
export const scrolledCjkPromptText = [
  '帮我看一下首页的加载动画，现在打开页面的时候会先白屏两三秒，然后图片一张一张地跳出来，看起来很卡。',
  '我希望先显示一个简单的骨架屏，等图片都加载好了再一起淡入，整个过程控制在一秒以内。',
  '另外顶部导航栏在手机上会被挡住一半，滚动的时候还会抖动，你也顺便查一下是不是样式的问题。',
  '改完以后先在本地跑一遍，截图给我看看效果，没问题再提交，提交说明写清楚改了哪些地方、为什么这么改。',
  '如果改动比较大，先把方案发给我确认，不要直接动线上的配置，也不要删掉旧的图片。',
  '另外页脚的版权年份还是去年的，也一起改掉；改好以后告诉我一共动了几个文件，每个文件大概改了什么。',
].join('');

export const scrolledCjkVisibleRows = [
  '入，整个过程控制在一秒以内。另外顶部导航栏在手机上会被挡住一半，滚动的时候还',
  '会抖动，你也顺便查一下是不是样式的问题。改完以后先在本地跑一遍，截图给我看看',
  '效果，没问题再提交，提交说明写清楚改了哪些地方、为什么这么改。如果改动比较大',
  '，先把方案发给我确认，不要直接动线上的配置，也不要删掉旧的图片。另外页脚的版',
  '权年份还是去年的，也一起改掉；改好以后告诉我一共动了几个文件，每个文件大概改',
  '了什么。',
];
export const scrolledCjkScreenText = [
  '                                                            ◐ medium · /effort',
  '─── ↑ 2 more ───────────────────────────────────────────────────────────────────',
  ...scrolledCjkVisibleRows.map((row) => `  ${row}`),
  '────────────────────────────────────────────────────────────────────────────────',
  '  [Sonnet 5.5] │ project',
  '  Context ░░░░░░ 0%',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n');
