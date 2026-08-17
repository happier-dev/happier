import { settingsProvidersTranslations } from './settingsProvidersTranslations';
import { providerSessionTranslations } from './providerSessionTranslations';
import { externalSessionOperationTranslations } from './externalSessionOperationTranslations';
import { externalSessionSettingsTranslations } from './externalSessionSettingsTranslations';
import { pluginPermissionTranslations } from './pluginPermissionTranslations';
import { sessionRemotePermissionGrantTranslations } from './sessionRemotePermissionGrantTranslations';
import { voiceReadinessTranslations } from './voiceReadinessTranslations';
import { voiceDiagnosticsConsentTranslations } from './voiceDiagnosticsConsentTranslations';
import { voiceProviderPrivacyTranslations } from './voiceProviderPrivacyTranslations';
import { pluginWebhookAdministrationTranslations } from './pluginWebhookAdministrationTranslations';
import { pluginAccountDataEraseTranslations } from './pluginAccountDataEraseTranslations';
import { pluginAccountReleaseSelectionTranslations } from './pluginAccountReleaseSelectionTranslations';
import { pluginInvocationLogTranslations } from './pluginInvocationLogTranslations';
import { eventAutomationComposerTranslations } from './eventAutomationComposerTranslations';

/**
 * Japanese translations for the Happier app
 * Values can be:
 * - String constants for static text
 * - Functions with typed object parameters for dynamic text
 */

const mcpServersUxTranslationExtension = {
  mcpServersConfiguredEmptySubtitle: 'サーバーを作成し、ホスト JSON をインポートするか、推奨プリセットをインストールしてください。',
  mcpServersHeroSubtitle: ({ configuredCount }: { configuredCount: number }) => `Happier で ${configuredCount} 件が設定済み`,
  mcpServersHeroSubtitleEmpty: 'サーバーは一度作成すれば、適用先をプレビューでき、他のツールで既に使っているものも取り込めます。',
  mcpServersSegmentConfigured: '設定済み',
  mcpServersSegmentConfiguredSubtitle: 'Happier のカタログ',
  mcpServersSegmentDetected: '検出済み',
  mcpServersSegmentDetectedSubtitle: 'プロバイダー設定ファイルで見つかりました',
  mcpServersSegmentPreview: 'プレビュー',
  mcpServersSegmentPreviewSubtitle: 'このセッションで利用される内容',
  mcpServersAdvancedTitle: '詳細',
  mcpServersAdvancedSubtitle: '厳格モードと検証動作',
  mcpServersDetectedDirectoryTitle: 'プロジェクトディレクトリ',
  mcpServersDetectedDirectorySubtitle: 'プロジェクトレベル設定用の任意のワークスペースパス',
  mcpServersDetectedDirectoryPlaceholder: '/プロジェクト/パス',
  mcpServersPreviewAgentTitle: 'バックエンド',
  mcpServersPreviewMachineTitle: 'マシン',
  mcpServersPreviewDeliveryTitle: 'ツール配信',
  mcpServersPreviewDirectoryTitle: 'ワークスペースディレクトリ',
  mcpServersPreviewDirectorySubtitle: 'セッションを開始する予定のフォルダーを選択してください',
  mcpServersPreviewDirectoryPlaceholder: '/workspace/パス',
  mcpServersPreviewRefreshTitle: 'プレビューを更新',
  mcpServersPreviewRefreshSubtitle: 'このコンテキスト向けの Happier とプロバイダー固有の MCP サーバーを解決します',
  mcpServersPreviewEmptyTitle: 'まだプレビューがありません',
  mcpServersPreviewEmptySubtitle: 'バックエンド、マシン、ディレクトリを選んでから更新すると、実際に有効になる MCP セットを確認できます。',
  mcpServersPreviewDirectoryRequired: 'このセッションをプレビューするにはディレクトリを選択してください。',
  mcpServersBuiltInDescription: 'Happier セッションでは常に利用できます。',
  mcpServersSourceHappier: 'Happier',
  mcpServersSourceBuiltIn: '組み込み',
  mcpServersSourceDetected: '検出済み',
  mcpServersQuickInstallTitle: 'クイックインストール',
  mcpServersQuickInstallSubtitle: '一般的な開発者向け MCP サーバーを一度でインストールします。',
  mcpServersQuickInstallAction: 'インストール',
  mcpServersQuickInstallEmptyTitle: 'プリセットを選択',
  mcpServersQuickInstallEmptySubtitle: '続行するには推奨 MCP サーバーのいずれかを選択してください。',
  mcpServersEditAction: '編集',
  mcpServersDeleteAction: '削除',
  mcpServersAddServerFlowSubtitle: 'サーバーを手動で設定する、ホスト JSON をインポートする、または厳選プリセットから始めます。',
  mcpServersAddFlowConfigureTitle: '設定',
  mcpServersAddFlowConfigureSubtitle: '手動設定',
  mcpServersAddFlowImportJsonTitle: 'JSON をインポート',
  mcpServersAddFlowImportJsonSubtitle: 'ホスト設定を貼り付けます',
  mcpServersAddFlowQuickInstallTitle: 'クイックインストール',
  mcpServersAddFlowQuickInstallSubtitle: '厳選プリセット',
  mcpServersFieldCommandLine: 'コマンドライン',
  mcpServersFieldCommandLinePlaceholder: 'npx -y @modelcontextprotocol/server-playwright',
  mcpServersTransportLocalTitle: 'ローカルコマンド',
  mcpServersTransportLocalSubtitle: '選択したマシンで実行されます',
  mcpServersTransportHttpTitle: 'リモート HTTP',
  mcpServersTransportHttpSubtitle: 'HTTP エンドポイントからのブリッジ',
  mcpServersTransportSseTitle: 'リモート SSE',
  mcpServersTransportSseSubtitle: 'サーバー送信イベントからのブリッジ',
  mcpServersAdvancedCommandEditorTitle: '高度なコマンドエディタ',
  mcpServersAdvancedCommandEditorSubtitle: 'コマンドと引数を手動で分割します',
  mcpServersCancelSubtitle: 'この下書きを保存せずに終了します',
  mcpServersImportJsonTitle: 'MCP ホスト JSON を貼り付け',
  mcpServersImportJsonSubtitle: 'README やデスクトップホストで使われる一般的な形式をサポートしています。',
  mcpServersImportJsonPlaceholder: '{"mcpServers":{"テスト":{"command":"npx","args":["-y","@playwright/mcp@latest"]}}}',
  mcpServersImportJsonErrorTitle: 'インポートエラー',
  mcpServersImportJsonWarningsTitle: 'インポート警告',
  mcpServersImportJsonEmptyTitle: 'まだサーバーが解析されていません',
  mcpServersImportJsonEmptySubtitle: 'インポート前にサーバーをプレビューするため、ホスト MCP JSON を貼り付けてください。',
  mcpServersImportJsonAction: 'サーバーをインポート',
  mcpServersImportMappingSavedSecret: '保存済みシークレットを使用',
  mcpServersImportMappingMachineEnv: 'マシン環境変数を使用',
  mcpServersImportSecretNamePlaceholder: '保存済みシークレット名',
  mcpServersImportSecretValuePlaceholder: '保存済みシークレット値',
  mcpServersImportMachineEnvPlaceholder: 'ENV_VAR_NAME',
  mcpServersImportMappingMissingSecretName: ({ input }: { input: string }) => `${input} の保存済みシークレット名を入力してください。`,
  mcpServersImportMappingMissingSecretValue: ({ input }: { input: string }) => `${input} の保存済みシークレット値を入力するか、マシン環境変数に切り替えてください。`,
  mcpServersImportMappingMissingMachineEnvName: ({ input }: { input: string }) => `${input} のマシン環境変数名を入力してください。`,
  mcpServersAuthSavedSecret: '保存済みシークレット',
  mcpServersAuthMachineEnv: 'マシン環境変数',
  mcpServersAuthPlainText: 'プレーンテキスト',
  mcpServersAuthUnknown: '不明な認証',
  mcpServersAuthNone: '認証なし',
  mcpServersScopeAllMachines: 'すべてのマシン',
  mcpServersScopeMachine: 'マシン',
  mcpServersScopeWorkspace: 'ワークスペース',
  mcpServersScopeProviderProject: 'プロバイダーのプロジェクト設定',
  mcpServersScopeProviderUser: 'プロバイダーのユーザー設定',
  mcpServersScopeBuiltIn: '組み込み',
  mcpServersStatusActive: '有効',
  mcpServersStatusAvailable: '利用可能',
  mcpServersStatusUnavailable: '利用不可',
  mcpServersStatusDetected: ({ provider }: { provider: string }) => `${provider} で有効`,
  mcpServersStatusDisabledInProvider: ({ provider }: { provider: string }) => `${provider} で無効`,
  mcpServersEditorAppliesTo: '適用先',
  mcpServersEditorAppliesToSubtitle: 'Happier がこのサーバーを既定で追加する場所を選んでください。',
  mcpServersAddApplyRule: '適用先ルールを追加',
  mcpServersAddApplyRuleSubtitle: 'このサーバーを既定で適用する場所を選んでください。',
  mcpServersAddApplyRuleHelp: 'この適用先ルールを保存して、このサーバー設定の一部にしてください。',
  mcpServersAddApplyRuleSave: '適用先ルールを保存',
  mcpServersDeliveryNativeTitle: 'ネイティブ MCP',
  mcpServersDeliveryNativeSubtitle: 'このバックエンドは Happier のツールをネイティブ MCP サーバーとして受け取ります。',
  mcpServersDeliveryShellBridgeTitle: 'Happier シェルブリッジ',
  mcpServersDeliveryShellBridgeSubtitle: 'このバックエンドは happier tools ブリッジ経由で Happier のツールを呼び出します。',
  mcpServersDeliveryUnsupportedTitle: '非対応',
  mcpServersDeliveryUnsupportedSubtitle: 'このバックエンドは現在 Happier のツールを受け取りません。',
} as const;

const newSessionMcpTranslationExtension = {
  mcpChipLabel: 'MCP',
  mcpChipLabelWithCount: ({ count }: { count: number }) => `MCP ${count}`,
  mcpModalTitle: 'MCPサーバー',
  mcpModalSubtitle: ({ machineName, directory }: { machineName: string; directory: string }) =>
    `${machineName} の ${directory} で利用できる MCP サーバーをプレビューします。`,
  mcpManagedToggleTitle: '管理対象のMCPサーバー',
  mcpManagedToggleSubtitle: 'このセッションで利用できる場合は、管理対象のMCPサーバーを含めます。',
  mcpOpenSettingsTitle: 'MCP設定を開く',
  mcpOpenSettingsSubtitle: '設定済みサーバー、バインディング、インポートオプションを管理します。',
  mcpUnavailableNoContextTitle: '先にマシンとディレクトリを選択してください',
  mcpUnavailableNoContextSubtitle: 'MCP プレビューには対象マシンとワークスペースディレクトリの両方が必要です。',
  mcpSelectedSectionTitle: '選択済み',
  mcpAvailableSectionTitle: '利用可能',
  mcpUnavailableSectionTitle: '利用不可',
  mcpDetectedSectionTitle: 'プロバイダー設定で検出',
  mcpDetectedSectionTitleForAgent: ({ agentName }: { agentName: string }) => `${agentName} の設定で検出`,
  mcpDetectedEmptyTitle: '検出された MCP サーバーはありません',
  mcpDetectedEmptySubtitle: '更新して、このマシン上のプロバイダー設定ファイルをスキャンしてください。',
  mcpDetectedUnsupportedTitle: '検出された MCP サーバーは利用できません',
  mcpDetectedUnsupportedSubtitle: 'このマシンで Happier を更新して、プロバイダー設定のスキャンを有効にしてください。',
  mcpHappierSectionTitle: 'Happier MCP サーバー',
  mcpHappierEmptyTitle: 'Happier に MCP サーバーが定義されていません',
  mcpHappierEmptySubtitle: '設定で MCP サーバーを定義してセッションで利用できます。',
  mcpReasonActiveByDefault: '既定で含まれる',
  mcpReasonForcedIncluded: '設定により必須',
  mcpReasonForcedExcluded: '設定により除外',
  mcpReasonManagedDisabled: '管理対象のMCPサーバーは無効です',
  mcpReasonBindingDisabled: 'サーバーバインディングにより無効',
  mcpReasonAvailablePortable: 'このセッションで利用可能',
  mcpReasonNotPortable: 'このセッションでは利用不可',
} as const;

const settingsAppearanceTranslationExtension = {
  themeProfiles: {
    title: 'Themes',
    editorTitle: 'Theme profile',
    activeGroup: 'Active theme',
    activeFooter: 'Choose the theme used by the interface. Manage custom themes from the themes screen.',
    builtInGroup: 'Built-in themes',
    builtInFooter: 'Built-in themes are read-only. Duplicate one to customize it locally.',
    customGroup: 'Custom themes',
    customFooter: 'Tap a theme to activate it, or use row actions to edit, duplicate, or delete it.',
    defaultTheme: 'Default theme',
    defaultThemeSubtitle: 'Use Happier theme colors without a custom profile',
    active: 'Active',
    customProfileSubtitle: 'Custom local theme profile',
    tapToActivate: 'Tap to activate',
    actionsGroup: 'Theme actions',
    createProfile: 'Create theme',
    createProfileSubtitle: 'Start from any built-in or custom theme',
    importProfile: 'Import theme',
    importProfileSubtitle: 'Paste JSON or choose a Happier theme profile file',
    exportProfile: 'Export theme',
    exportProfileSubtitle: 'Export this theme as JSON',
    presetsGroup: 'Built-in presets',
    presetsFooter: 'Built-in profiles are read-only. Clone one to customize it.',
    presets: {
      premiumDark: 'Crisp Dark',
      pitchDark: 'Pitch Dark',
      sunsetDark: 'Sunset Dark',
      nightDark: 'Night Dark',
      classicDark: 'Classic Dark',
      graphiteDark: 'Graphite Dark',
      tokyoNight: 'Tokyo Night',
      premiumLight: 'Crisp Light',
      paperLight: 'Paper Light',
      catppuccinMocha: 'Catppuccin Mocha',
      catppuccinMacchiato: 'Catppuccin Macchiato',
      catppuccinFrappe: 'Catppuccin Frappé',
      oneDarkPro: 'One Dark Pro',
      monokaiPro: 'Monokai Pro',
      githubDark: 'GitHub Dark',
      darkModern: 'Dark Modern',
      catppuccinLatte: 'Catppuccin Latte',
      githubLight: 'GitHub Light',
    },
    readOnlyPreset: 'Read-only preset',
    clonePreset: 'Clone preset',
    cloneProfile: 'Clone profile',
    duplicateTheme: 'Duplicate theme',
    editProfile: 'Edit profile',
    newProfileName: ({ count }: { count: number }) => `Custom theme ${count}`,
    cloneName: ({ name }: { name: string }) => `${name} copy`,
    detailsGroup: 'Details',
    presetGroup: 'Preset',
    presetSource: 'Preset',
    presetSourceSubtitle: 'Choose a theme to use as the starting point',
    assetAppearance: 'Asset appearance',
    assetAppearanceSubtitle: 'Choose whether this theme uses light or dark app assets.',
    replacePresetTitle: 'Replace current colors?',
    replacePresetSubtitle: 'Changing preset will replace the current draft colors. Unsaved color edits will be discarded.',
    profileName: 'Profile name',
    editorModeGroup: 'Theme mode',
    editorModeFooter: 'This theme edits the color mode selected by its preset.',
    editorMode: 'Variant',
    lightMode: 'Light',
    darkMode: 'Dark',
    previewTitle: 'Theme preview',
    previewSubtitle: 'A local sandbox preview of surfaces, text, controls, state, and syntax colors.',
    previewButton: 'Primary action',
    previewStatus: 'Ready',
    previewCode: 'const theme = "happier";',
    colorInputPlaceholder: '#RRGGBB, rgba(...), transparent',
    tokenSubtitle: 'Public color token override',
    recentColors: 'Recent colors',
    colorPickerFallback: 'Enter a color value or reuse a recent color.',
    invalidColor: 'Use hex, rgb(...), rgba(...), or transparent.',
    invalidProfileName: 'Invalid profile name.',
    profileLimitReached: 'Theme limit reached.',
    contrastWarning: 'Low contrast for this token pair. You can still save or reset.',
    resetToken: 'Reset token',
    resetGroup: 'Reset and deactivate',
    resetMode: 'Reset theme colors',
    deactivateProfile: 'Use default theme',
    deactivateProfileSubtitle: 'Deactivate the custom profile and keep it saved',
    deleteProfile: 'Delete profile',
    deleteProfileSubtitle: 'Remove this local custom theme profile',
    saveAndActivate: 'Save & Activate',
    missingProfile: 'Theme profile not found',
    importFooter: ({ formats }: { formats: string }) => `Supported formats: ${formats}. Unknown tokens are reported as warnings.`,
    importJson: 'Theme JSON',
    importJsonPlaceholder: "Paste your theme's JSON here",
    importFile: 'Choose file',
    importWarnings: ({ count }: { count: number }) => `${count} warning(s) were found while importing.`,
    importErrors: {
      invalidJson: 'The pasted text is not valid JSON.',
      unsupportedSchema: 'This theme profile version is not supported.',
      invalidProfile: 'This theme profile could not be imported.',
      tooLarge: 'This theme profile JSON is too large.',
    },
    exportFooter: 'Exported JSON includes all public color token values for this theme.',
    exportJson: 'Export JSON',
    copyExportJson: 'Copy JSON',
    downloadExportJson: 'Download JSON',
    noProfiles: 'No custom themes yet',
    groups: {
      background: 'Background',
      surface: 'Surfaces',
      border: 'Borders',
      effect: 'Effects',
      chrome: 'Chrome',
      text: 'Text',
      state: '状態',
      control: 'Controls',
      composer: 'Composer',
      message: 'Messages',
      syntax: 'Syntax',
      versionControl: 'Version control',
      diff: 'Diffs',
      permission: 'Permissions',
      overlay: 'Overlays',
    },
  },
  sessionListDensity: {
    title: 'セッション一覧の密度',
    subtitle: 'サイドバーでのセッションの表示方法を選択',
    detailed: '詳細',
    detailedDescription: 'アバターとステータスを含む標準サイズの行',
    cozy: '中間',
    cozyDescription: 'アバター付きの小さめの行',
    narrow: '狭い',
    narrowDescription: 'マイクロアバター付きの細い行',
  },
} as const;

const jaAcpCatalogSettingsExtension = {
    acpCatalog: 'ACP バックエンド',
    acpCatalogSubtitle: '組み込みとカスタムの ACP バックエンドを管理',
    acpCatalogBuiltIn: '組み込み ACP',
    acpCatalogBuiltInFooter:
        '組み込みの汎用 ACP エージェントは共有カタログで定義され、共有 ACP ランタイムで実行されます。',
    acpCatalogBackends: 'カスタムバックエンド',
    acpCatalogBackendsFooter:
        '各カスタムバックエンドは、独自の起動方法・既定値・認証設定を持つ、選択可能な ACP 互換 CLI 定義です。',
    acpCatalogBackendsEmptyTitle: 'カスタム ACP バックエンドはありません',
    acpCatalogBackendsEmptySubtitle: 'バックエンドを追加して、選択可能なカスタム ACP バックエンドを作成します。',
    acpCatalogAddBackend: 'ACP バックエンドを追加',
    acpCatalogAddBackendSubtitle: 'カスタム ACP バックエンドを作成',
    acpCatalogBackendEditorTitle: 'ACP バックエンド',
    acpCatalogBasics: '基本',
    acpCatalogLauncher: '起動方法',
    acpCatalogEnv: '環境',
    acpCatalogAddEnv: '環境変数を追加',
    acpCatalogAddEnvSubtitle: 'リテラル値を保存するか、保存済みシークレットを紐付けます',
    acpCatalogEnvEmptyTitle: '環境変数はありません',
    acpCatalogEnvEmptySubtitle: 'このバックエンドの起動時変数を追加します。',
    acpCatalogAuth: '認証',
    acpCatalogAuthSupport: '認証サポート',
    acpCatalogAuthParser: '状態パーサー',
    acpCatalogCapabilities: '機能',
    acpCatalogTransportProfile: '転送プロファイル',
    acpCatalogSupportsModes: 'モードをサポート',
    acpCatalogSupportsModels: 'モデルをサポート',
    acpCatalogSupportsConfigOptions: '設定オプションをサポート',
    acpCatalogPromptImageSupport: 'プロンプト画像サポート',
    acpCatalogFieldId: 'ID',
    acpCatalogFieldName: '名前',
    acpCatalogFieldTitle: 'タイトル',
    acpCatalogFieldDescription: '説明',
    acpCatalogFieldCommand: 'コマンド',
    acpCatalogFieldArgs: '引数（1 行に 1 つ）',
    acpCatalogMachineLoginKey: 'マシンのログインキー',
    acpCatalogDocsUrl: 'ドキュメント URL',
    acpCatalogLoginCommand: 'ログインコマンド',
    acpCatalogLoginArgs: 'ログイン引数（1 行に 1 つ）',
    acpCatalogStatusCommand: '状態コマンドのトークン（1 行に 1 つ）',
    acpCatalogDefaultMode: '既定モード',
    acpCatalogDefaultModel: '既定モデル',
    acpCatalogDeleteBackendTitle: 'ACP バックエンドを削除しますか？',
    acpCatalogDeleteBackendConfirm: ({ name }: { name: string }) => `「${name}」を削除しますか？`,
    acpCatalogValidationFailed: 'ACP カタログ設定が無効です。',
} as const;

const acpCatalogTranslationExtension = {
  settings: jaAcpCatalogSettingsExtension,
  newSession: {},
} as const;

const memoryEmbeddingsTranslationExtension = {
  status: {
    embeddingsTitle: '埋め込みランタイム',
    embeddingsProviderTitle: '埋め込みプロバイダ',
    embeddingsModelTitle: '埋め込みモデル',
    embeddingsDisabled: '埋め込みは無効です',
    embeddingsReady: '埋め込みは準備完了です',
    embeddingsDownloading: '埋め込みモデルをダウンロード中です',
    embeddingsFallback: '埋め込みが利用できないため、テキストのみのフォールバックを使用しています',
    embeddingsUnavailable: '埋め込みは利用できません',
    embeddingsError: '埋め込みの初期化に失敗しました',
    embeddingsProviderLocal: 'ローカルモデル',
    embeddingsProviderOpenAiCompatible: 'OpenAI 互換エンドポイント',
  },
  embeddings: {
    groupTitle: '埋め込み',
    groupFooter:
      '任意: ローカルモデルまたは独自の OpenAI 互換エンドポイントでディープ検索のランキング精度を向上できます。',
    mode: {
      title: '埋め込みモード',
      options: {
        disabledTitle: 'オフ',
        disabledSubtitle: 'ディープ検索ではテキストのみのランキングを使用',
        balancedTitle: 'バランス',
        balancedSubtitle: '高速で検証済みのローカルプリセット',
        longContextTitle: '長文コンテキスト',
        longContextSubtitle: 'より大きな会話チャンクに適しています',
        qualityTitle: '品質',
        qualitySubtitle: '評価向けの高コストなローカルプリセット',
        customTitle: 'カスタム',
        customSubtitle: '独自のプロバイダとモデルを選択',
      },
    },
    provider: {
      title: 'プロバイダ',
      options: {
        localTitle: 'ローカルモデル',
        localSubtitle: 'Happier によって管理され、初回使用時にダウンロードされます',
        openAiCompatibleTitle: 'OpenAI 互換エンドポイント',
        openAiCompatibleSubtitle: '独自の埋め込みサーバーと API キーを使用します',
      },
    },
    notSet: '未設定',
    secretSet: '設定済み',
    secretNotSet: '未設定',
    queryPrefixTitle: 'クエリ接頭辞',
    queryPrefixPromptBody: '埋め込み前にユーザー検索クエリへ付与する任意の接頭辞です。',
    documentPrefixTitle: 'ドキュメント接頭辞',
    documentPrefixPromptBody: '埋め込み前にインデックス化済みメモリチャンクへ付与する任意の接頭辞です。',
    openAi: {
      baseUrlTitle: 'ベース URL',
      baseUrlPromptBody: 'OpenAI 互換の埋め込みエンドポイントのベース URL を入力してください。',
      modelTitle: 'リモートモデル',
      modelPromptBody: 'リモートエンドポイントへ要求する埋め込みモデル ID を入力してください。',
      apiKeyTitle: 'API キー',
      apiKeyPromptBody: 'リモート埋め込みエンドポイントで使う API キーを入力してください。',
      dimensionsTitle: '次元',
      dimensionsPromptBody: '対応エンドポイント向けの出力次元の任意上書きです。',
    },
    advanced: {
      ftsWeightTitle: 'テキストランキングの重み',
      ftsWeightPromptBody: '結果を統合する際の SQLite 全文ランキングの相対的な重みです。',
      embeddingWeightTitle: '埋め込みランキングの重み',
      embeddingWeightPromptBody: '結果を統合する際の埋め込み類似度の相対的な重みです。',
    },
  },
} as const;

const promptLibraryUxRefinementTranslationExtension = {
  ja: {
    promptsSubtitle: '再利用できるプロンプト文書',
    skillsSubtitle: '再利用できるスキルバンドル',
    addPrompt: '新しいプロンプトを追加',
    addPromptSubtitle: '新しいプロンプト文書を作成',
    addSkill: '新しいスキルを追加',
    addSkillSubtitle: '新しいスキルバンドルを作成',
    newTemplateSubtitle: '再利用できるスラッシュテンプレートを作成',
    noPrompts: 'プロンプトはまだありません',
    noPromptsSubtitle: 'テンプレートやシステムプロンプト追加を始めるには、まずプロンプトを作成してください。',
    noSkills: 'スキルはまだありません',
    noSkillsSubtitle: 'SKILL.md の指示を再利用するには、スキルバンドルを作成してください。',
    imported: 'インポート済み',
    builtIn: '組み込み',
    general: '一般',
    promptNameLabel: 'プロンプト名',
    promptContent: 'プロンプト内容',
    skillNameLabel: 'スキル名',
    skillContent: 'SKILL.md の内容',
    supportingFiles: '補助ファイル',
    supportingFilesEmptyTitle: '補助ファイルはまだありません',
    supportingFilesEmptySubtitle: 'このスキルと一緒に書き出す再利用ファイルを追加します。',
    supportingFilesSaveFirstTitle: '先にこのスキルを保存してください',
    supportingFilesSaveFirstSubtitle: '補助ファイルを追加する前にスキルを作成してください。',
    addSupportingFile: '補助ファイルを追加',
    addSupportingFileSubtitle: 'このスキルバンドルに別のファイルを作成',
    editSupportingFile: '補助ファイルを編集',
    newSupportingFile: '新しい補助ファイル',
    supportingFilePathLabel: 'ファイルパス',
    supportingFilePathPlaceholder: 'templates/review.md',
    supportingFileContent: 'ファイル内容',
    supportingFileTextSubtitle: 'テキストファイル',
    supportingFileBinarySubtitle: 'バイナリファイル · 書き出し専用',
    deleteSupportingFileTitle: '補助ファイルを削除しますか？',
    deleteSupportingFileConfirm: 'このファイルをスキルバンドルから削除します。',
    linkedAssetsCount: ({ count }: { count: number }) => `${count} 件のエクスポート`,
    manageExternalAssets: '外部アセットを管理',
    deleteLibraryItemTitle: 'ライブラリ項目を削除しますか？',
    deleteLibraryItemBody: 'これにより、ライブラリから項目が削除され、それを参照するテンプレートやシステムプロンプト追加も解除されます。',
    folders: 'フォルダー',
    foldersSubtitle: 'プロンプトとスキルを名前付きフォルダーで整理します',
    addFolder: 'フォルダーを追加',
    addFolderSubtitle: 'ライブラリ項目用の再利用フォルダーを作成します',
    foldersEmptyTitle: 'フォルダーはまだありません',
    foldersEmptySubtitle: 'プロンプトとスキルを整理するにはフォルダーを作成してください。',
    renameFolder: 'フォルダー名を変更',
    deleteFolderTitle: 'フォルダーを削除しますか？',
    deleteFolderBody: 'このフォルダーを使っているプロンプトとスキルからフォルダー割り当てを外します。',
    folderUsageCount: ({ count }: { count: number }) => `${count} 件の項目`,
    folderLabel: 'フォルダー',
    folderPlaceholder: 'フォルダー名',
    tagsLabel: 'タグ',
    tagsPlaceholder: 'tag-ichi, tag-ni',
    addToStackSubtitle: 'ここに追加するプロンプトまたはスキルを選択',
    externalAssetsImportAction: 'インポート',
    externalAssetsLinkedTo: ({ title }: { title: string }) => `${title} にリンク済み`,
    externalAssetsExportTarget: '保存先',
    externalAssetsInstallMethod: 'インストール方法',
    externalAssetsInstallMethodCopy: 'ファイルをコピー',
    externalAssetsInstallMethodCopySubtitle: '選択した保存先に独立したコピーを書き込みます',
    externalAssetsInstallMethodSymlink: 'シンボリックリンク（推奨）',
    externalAssetsInstallMethodSymlinkSubtitle: '更新しやすいように保存先を Happier 管理のコピーへリンクします',
    registriesAddGitSourceSubtitle: 'Git リポジトリまたはローカルチェックアウトをレジストリソースとして追加',
    registriesSourceTitleLabel: 'ソース名',
    registriesSourceUrlLabel: 'リポジトリ URL またはローカルパス',
    registriesSearchLabel: 'レジストリを検索',
    registriesSearchPlaceholder: 'スキルを検索 (例: design)',
    registriesItemSource: 'ソースリポジトリ',
    registriesItemPath: 'レジストリパス',
    registriesItemFiles: '補助ファイル',
    registriesItemPreview: 'SKILL.md プレビュー',
    registriesItemPreviewUnavailable: 'このレジストリアイテムでは SKILL.md のプレビューを利用できません。',
    registriesItemImportSubtitle: 'このスキルバンドルを Happier ライブラリに取り込む',
    registriesItemInstallAction: 'マシンにインストール',
    registriesItemInstallConfirmTitle: 'レジストリアイテムをインストールしますか？',
    registriesItemInstallConfirmBody: 'このスキルをライブラリに取り込み、選択したマシンの保存先へインストールします。',
    templateTargetPromptLabel: 'プロンプト',
    templateTargetPromptPlaceholder: 'プロンプトを選択',
    editSelectedPrompt: '選択したプロンプトを編集',
    editSelectedPromptDisabled: '先にプロンプトを選択してください',
    templateNameLabel: 'テンプレート名',
    templateTokenLabel: 'スラッシュコマンド',
    templatesEmptyTitle: 'テンプレートはまだありません',
    templatesEmptySubtitle: 'プロンプトを素早く挿入するには、スラッシュテンプレートを作成してください。',
    librarySearchPlaceholder: 'ライブラリを検索',
  },
} as const;

const sessionHandoffTranslationExtensions = {
  ja: {
    activeWarning: {
      title: 'このセッションはこのマシンでまだ実行中です',
      message: 'ハンドオフを開始すると、選択したマシンへ転送する前にこのマシン上のセッションを停止します。',
      confirm: 'ここで停止してハンドオフ',
    },
    progress: {
      title: 'セッションを引き継ぎ中',
      message: '対象のマシンを準備し、セッションの状態を移動しています。',
      planned: '計画済み',
      transferred: '転送済み',
      remaining: '残り',
      timeline: {
        scanSource: 'ソースをスキャン',
        plan: '変更を計画',
        transferBlobs: 'ファイルを転送',
        stageTarget: 'ターゲットを準備',
        apply: '変更を適用',
        importSession: 'セッションをインポート',
        finalize: '完了',
      },
    },
    failure: {
      title: 'セッションの引き継ぎに失敗しました',
      message: '引き継ぎを完了できませんでした。もう一度転送を試せます。',
    },
    recovery: {
      title: 'ハンドオフ完了前にこのマシンでセッションが停止されました',
      messageAfterSourceStop:
        'Happier はこのマシン上のセッションをすでに停止しましたが、転送先マシンでの起動を完了できませんでした。ここで再起動するか、転送先マシンの復旧中は停止したままにしてください。',
      restartOnSource: '元の環境で再開',
      keepStopped: '停止したままにする',
    },
  },
} as const;

const settingsSessionHandoffTranslationExtensions = {
  ja: {
    title: 'セッションの引き継ぎ',
    groupTitle: 'セッションの引き継ぎ',
    groupFooter: 'セッションを別のマシンへ移すときの既定値を選びます。',
    entrySubtitle: '引き継ぎの既定値を開く',
    workspaceTransfer: {
      groupTitle: 'ワークスペース転送',
      groupFooter: '引き継ぎ時にワークスペースをコピーするか、競合をどう扱うかを既定で決めます。',
      title: 'ワークスペースを転送',
      enabledSubtitle: '既定でワークスペースを対象マシンへコピーします。',
      disabledSubtitle: '既定で対象側のワークスペースを変更しません。',
      strategy: {
        title: 'ワークスペース転送方式',
        subtitle: '完全なスナップショットを転送するか、変更だけを同期するかを選びます。',
        transferSnapshotTitle: 'スナップショットを転送',
        transferSnapshotSubtitle: 'ワークスペース全体のスナップショットをエクスポートして転送します。',
        syncChangesTitle: '変更を同期',
        syncChangesSubtitle: '元と先のワークスペースを比較し、必要な片方向の変更だけを適用します。',
      },
    },
    conflictPolicy: {
      title: 'ワークスペース競合ポリシー',
      subtitle: '対象パスが既に存在する場合の動作を選びます。',
      createSiblingCopyTitle: '隣接コピーを作成',
      createSiblingCopySubtitle: '既存の対象パスを保持し、引き継ぎ用に隣接コピーを作成します。',
      replaceExistingTitle: '既存パスを置き換え',
      replaceExistingSubtitle: '確認後に既存の対象パスを置き換えます。',
    },
    includeIgnoredMode: {
      title: '無視されたファイル',
      subtitle: 'ワークスペース転送時に git ignore のファイルをどう扱うかを選びます。',
      excludeTitle: '無視されたファイルを除外',
      excludeSubtitle: '既定で無視されたファイルをスキップします。',
      includeSelectedTitle: '選択した無視ファイルを含める',
      includeSelectedSubtitle: '設定した glob に一致する無視パスだけをコピーします。',
      globsTitle: '無視ファイルの include glob',
      globsPlaceholder: 'dist/**, .env.local',
    },
    directTargetMode: {
      title: 'ダイレクトセッションの移行先モード',
      subtitle: 'ダイレクトセッションを引き継ぐときの動作を選びます。',
      groupTitle: 'ダイレクトセッションの引き継ぎ',
      groupFooter: '元のセッションが現在ダイレクトのときだけ適用されます。',
      keepDirectTitle: 'ダイレクトのまま',
      keepDirectSubtitle: 'プロバイダーが対応していれば、移行先をダイレクトセッションとして再開します。',
      convertToPersistedTitle: 'Happier に変換',
      convertToPersistedSubtitle: 'トランスクリプトを取り込み、Happier セッションとして続けます。',
    },
  },
} as const;

export const ja = {
    transferRecovery: {
        title: '一時アップロードを完了',
        message: 'アップロードはマシンに届きましたが、最後の保存を完了できませんでした。最終処理だけを再試行するか、一時アップロードを破棄してください。',
        retryFinalization: '最終処理を再試行',
        discardStagedUpload: '一時アップロードを破棄',
        discarded: '一時アップロードを破棄しました。',
        unavailable: 'この一時アップロードは利用できなくなりました。',
    },
    voice: voiceReadinessTranslations.ja,
    pluginPermissions: pluginPermissionTranslations.ja,
    sessionRemotePermissionGrants: sessionRemotePermissionGrantTranslations.ja,
    pluginSurfaces: {
        state: {
            loading: { title: 'プラグインコンテンツを読み込み中', reason: 'Happier が最新の更新を読み込む間、利用可能なコンテンツを表示しています。' },
            refreshing: { title: 'プラグインコンテンツを更新中', reason: 'Happier が更新を確認する間、最後に利用できたコンテンツを表示しています。' },
            stale: { title: 'プラグインコンテンツが古い可能性があります', reason: '最後に利用できたコンテンツを表示しています。更新を確認するには再試行してください。' },
            offline: { title: 'プラグインコンテンツはオフラインです', reason: '再接続するまで、最後に利用できたコンテンツを読み取り専用で表示しています。' },
        },
        offlineSnapshot: {
            accessibilityLabel: ({ title }: { title: string }) =>
                `${title} のオフラインスナップショット。再接続するまでコンテンツは読み取り専用です。`,
        },
        hostRenderer: {
            descriptorPanel: {
                accessibilityLabel: 'プラグインパネル',
                untitled: 'プラグインパネル',
            },
        },
        appPage: {
            title: 'プラグインページ',
            subtitle: 'インストール済みプラグインが提供する全画面の移動先です。',
            empty: '利用可能なプラグインページはありません。',
            unknown: 'このプラグインページは利用できません。プラグインが読み込み中、無効化済み、またはアンインストール済みの可能性があります。',
        },
        appScopeRightSidebar: {
            empty: '利用可能なアプリのプラグインタブはありません。',
        },
    },
    settingsKeyboard: {
        title: 'Keyboard shortcuts',
        entrySubtitle: 'Discover and control app shortcuts',
        generalGroupTitle: 'Keyboard controls',
        generalGroupFooter: 'Shortcut preferences are stored locally on this device.',
        enableShortcutsTitle: 'Enable unified shortcuts',
        enableShortcutsSubtitle: 'Use the new keyboard command registry for app shortcuts.',
        singleKeyTitle: 'Single-key shortcuts',
        singleKeySubtitle: 'Allow shortcuts such as ? when text input is not focused.',
        conflictsTitle: ({ count }: { count: number }) => `${count} shortcut conflict${count === 1 ? '' : 's'} detected`,
        conflictsSubtitle: ({ count }: { count: number }) => `${count} command${count === 1 ? '' : 's'} need review before all shortcuts can be active.`,
        conflictsGroupTitle: 'Diagnostics',
        commandsGroupTitle: 'Commands',
        commandsGroupFooter: 'Defaults are shown from the shortcut registry. Set a custom shortcut, disable a command, or reset it to recover the default binding.',
        noDefaultShortcut: 'No default shortcut',
        setCommandButton: 'Set',
        setCommandAccessibility: ({ command }: { command: string }) => `Set ${command} shortcut`,
        setShortcutPromptTitle: ({ command }: { command: string }) => `Set shortcut for ${command}`,
        setShortcutPromptMessage: 'Enter a shortcut such as Alt+K, Alt+ArrowDown, Mod+Enter, or ?.',
        setShortcutPromptPlaceholder: 'Alt+K',
        setShortcutInvalidTitle: 'Invalid shortcut',
        setShortcutInvalidMessage: 'Enter at least one non-modifier key, optionally with Mod, Ctrl, Shift, or Alt.',
        resetCommandAccessibility: ({ command }: { command: string }) => `Reset ${command} shortcut`,
        commands: {
            composerAbortConfirm: '中断を確認',
            composerFocus: 'コンポーザーにフォーカス',
            composerSendImmediate: 'すぐに送信',
            composerSendPending: '保留キューに送信',
            commandPaletteOpen: 'コマンドパレットを開く',
            modeCycle: 'モードを切り替え',
            shortcutsHelpOpen: 'ショートカットヘルプを開く',
            sessionNew: '新しいセッションを作成',
            sessionMruNext: '次の最近使ったセッション',
            sessionMruPrevious: '前の最近使ったセッション',
            sessionVisibleNext: '次の表示中セッション',
            sessionVisiblePrevious: '前の表示中セッション',
            sessionsRowMoveUp: 'Move selected row up',
            sessionsRowMoveDown: 'Move selected row down',
            sessionsRowMoveToFolder: 'Move selected row to folder',
            sessionsRowMoveToWorkspaceRoot: 'Move selected row to workspace root',
            sessionsSelectionToggleFocused: 'Select focused session',
            sessionsSelectionExtendUp: 'Extend session selection up',
            sessionsSelectionExtendDown: 'Extend session selection down',
            sessionsSelectionSelectAll: 'Select all visible sessions',
            sessionsSelectionClear: 'Clear session selection',
            settingsOpen: '設定を開く',
            transcriptSelectionCancel: 'Cancel transcript selection',
            transcriptSelectionCopy: 'Copy selected transcript messages',
            transcriptSelectionSelectAll: 'Select all transcript messages',
            transcriptSelectionSendToSession: 'Send selected transcript messages to session',
            transcriptScrollBottom: 'トランスクリプトの末尾へ移動',
            transcriptScrollPageDown: 'トランスクリプトを1ページ下へ',
            transcriptScrollPageUp: 'トランスクリプトを1ページ上へ',
            transcriptScrollTop: 'トランスクリプトの先頭へ移動',

            permissionCycle: "Cycle permission mode",
            splitCanvasCloseLeaf: "Close split",
            splitCanvasFocusDown: "Focus split below",
            splitCanvasFocusLeft: "左の分割にフォーカス",
            splitCanvasFocusRight: "右の分割にフォーカス",
            splitCanvasFocusUp: "上の分割にフォーカス",
            splitCanvasRestoreMaximize: "最大化した分割を元に戻す",
            splitCanvasSplitDown: "下に分割",
            splitCanvasSplitRight: "右に分割",
            splitCanvasToggleMaximize: "分割の最大化を切り替え",
            transcriptMessageNext: "次のメッセージ",
            transcriptMessagePrevious: "前のメッセージ",},
    },

  tabs: {
    // Tab navigation labels
    inbox: "受信箱",
    friends: "友達",
    sessions: "セッション",
    settings: "設定",

    projects: "プロジェクト",},

  transcript: {


    unsupportedContent: {

      unparsedUserMessage: '解析できないユーザーメッセージ',

      unparsedAgentMessage: '解析できないアシスタントメッセージ',

      unsupportedAgentOutput: 'サポートされていない出力',

      unsupportedTranscriptRecord: 'サポートされていない記録',

    },

    selection: {

      enterA11y: '選択モードに入る',

      exitA11y: '選択モードを終了',

      rowA11y: ({ role, preview }: { role: string; preview: string }) => `${role}: ${preview}`,

      selectedCount: ({ count }: { count: number }) => count === 1 ? '1 message selected' : `${count} messages selected`,

      selectAll: 'すべて選択',

      deselectAll: '選択を解除',

      cancel: 'キャンセル',

      copy: 'コピー',

      copyA11y: ({ count }: { count: number }) => count === 1 ? 'Copy 1 message' : `Copy ${count} messages`,

      send: '送信',

      sendA11y: ({ count }: { count: number }) => count === 1 ? 'Send 1 message to another session' : `Send ${count} messages to another session`,

      copySuccess: 'コピーしました',

      copyFailed: 'コピーに失敗しました',

      sendTo: {

        modalTitle: 'セッションに送信',

        modalSubtitle: '選択したメッセージを別のセッション下書きに追加',

        newSession: '新規セッション',

        newSessionSubtitle: '新規セッションの下書きに追加',

        searchPlaceholder: 'Search sessions...',

        noResults: '一致するセッションはありません',

        currentExcluded: '現在のセッションは表示されません',

        preview: 'プレビュー',

        previewNote: 'これは送信先の入力欄に表示されます',

        addNote: 'メモを追加（任意）',

        addNotePlaceholder: 'Type a note to prepend...',

        send: '送信',

        cancel: 'キャンセル',

        sendFailed: '送信に失敗しました',

        sendSuccessNavigating: '送信しました — セッションを開いています',

      },

    },

    progress: {

      catchingUp: '追いついています…',

    },

  },


  inbox: {
    openSession: ({ session }: { session: string }) => `セッションを開く: ${session}`,
    // Inbox screen
    emptyTitle: "すべて完了です",
    emptyDescription: "現在、保留中のリクエストや更新はありません。",
    approvals: "承認",
    permissions: "権限",
    unreadSessions: "未読のセッション",
    updates: "アクティビティ",
  },

  approvals: {
    title: "承認",
    untitled: "無題の承認",
    details: "詳細",
    fieldStatus: "ステータス",
    fieldAction: "アクション",
    approve: "承認",
    reject: "拒否",
    loadError: "承認を読み込めませんでした。",
    decisionError: "承認を更新できませんでした。",
    confirmApproveTitle: "承認しますか？",
    confirmApproveBody: "要求されたアクションを実行します。",
    confirmRejectTitle: "拒否しますか？",
    confirmRejectBody: "要求を拒否します。",
    proposedComments: ({ count }: { count: number }) => `提案されたコメント ${count} 件`,
    generation: ({ generation }: { generation: string }) => `世代: ${generation}`,
    status: {
      open: "保留中",
      approved: "承認済み",
      rejected: "拒否済み",
      executed: "実行済み",
      failed: "失敗",
      canceled: "キャンセル",
    },
  },

  promptLibrary: {
    sections: "セクション",
    library: "ライブラリ",
    librarySubtitle: "プロンプトとスキルを管理",
    create: "作成",
    newPrompt: "新しいプロンプト",
    newSkill: "新しいスキル",
    prompts: "プロンプト",
    skills: "スキル",
    untitledPrompt: "無題のプロンプト",
    untitledSkill: "無題のスキル",
    origin: "由来",
    schema: "スキーマ",
    editPrompt: "プロンプトを編集",
    editSkill: "スキルを編集",
    titlePlaceholder: "タイトル",
	    saveError: "保存できませんでした。",
	    templates: "テンプレート",
	    templatesSubtitle: "/スラッシュ テンプレートを作成・管理",
	    newTemplate: "新しいテンプレート",
	    stacks: "スタック",
	    stacksSubtitle: "プロンプトとスキルをセッションとプロフィールに追加",
        externalAssets: "外部アセット",
        externalAssetsSubtitle: "接続済みマシンからスキルとプロンプトアセットをインポート",
        externalAssetsContext: "検出コンテキスト",
        externalAssetsMachine: "マシン",
        externalAssetsScope: "スコープ",
        externalAssetsProjectScope: "プロジェクト",
        externalAssetsProjectScopeSubtitle: "ワークスペースのパス内にあるアセットを検出",
        externalAssetsUserScope: "ユーザー",
        externalAssetsUserScopeSubtitle: "ユーザー レベルのフォルダーにあるアセットを検出",
        externalAssetsProjectDirectory: "プロジェクト ディレクトリ",
        externalAssetsProjectDirectoryRequired: "プロジェクト範囲のアセットをインポートまたはエクスポートする前に、プロジェクト ディレクトリを選択してください。",
        externalAssetsRefresh: "外部アセットを更新",
        externalAssetsRefreshSubtitle: "選択したマシンとスコープのプロンプトアセットを検出",
        externalAssetsTypes: "アセットの種類",
        externalAssetsNoMachine: "続行するにはマシンを選択してください。",
        externalAssetsNoTypes: "外部アセットの種類がありません",
        externalAssetsNoTypesSubtitle: "このマシンはまだプロンプトアセット アダプターを公開していません。",
        externalAssetsNoItems: "外部アセットが見つかりません",
        externalAssetsNoItemsSubtitle: "マシン、スコープ、またはディレクトリを選択してから更新してください。",
        externalAssetsUnsupportedImport: "ここでは bundle ベースのプロンプトアセットのみインポートできます。",
        externalAssetsExportTitle: "外部アセットをエクスポート",
        externalAssetsExportOptions: "エクスポート設定",
        externalAssetsExportType: "アセットの種類",
        externalAssetsExportAction: "エクスポート",
        externalAssetsExportConfirmTitle: "外部アセットをエクスポートしますか？",
        externalAssetsExportConfirmBody: "選択したプロンプト資産を外部の場所に書き出します。",
        externalAssetsExportTargetPathPlaceholder: "保存先パス（例: review/code.md）",
        externalAssetsExportTargetNamePlaceholder: "保存先名（例: reviewer）",
        externalAssetsDeleteConfirmTitle: "外部アセットを削除しますか？",
        externalAssetsDeleteConfirmBody: "リンクされた外部アセットをディスクから削除します。",
        externalAssetsLinkedTitle: "リンクされた外部アセット",
        registries: "レジストリ",
        registriesSubtitle: "スキル レジストリを参照し、bundle をライブラリにインポート",
        registriesContext: "レジストリ コンテキスト",
        registriesNoMachine: "続行するにはマシンを選択してください。",
        registriesRefresh: "レジストリを更新",
        registriesRefreshSubtitle: "選択したマシンの組み込みおよび設定済みレジストリ ソースを読み込む",
        registriesAddGitSource: "Git ソースを追加",
        registriesAddGitSourceAction: "Git ソースを保存",
        registriesAddGitSourceActionSubtitle: "このリポジトリをレジストリ ソースとして保存",
        registriesAddGitSourceError: "タイトルとリポジトリ URL の両方を追加してください。",
        registriesSourceTitlePlaceholder: "ソース タイトル",
        registriesSourceUrlPlaceholder: "リポジトリ URL またはローカル パス",
        registriesSources: "ソース",
        registriesNoSources: "レジストリ ソースが読み込まれていません",
        registriesNoSourcesSubtitle: "Git ソースを追加するか、更新して組み込みソースを読み込んでください。",
        registriesItems: "レジストリ項目",
        registriesNoItems: "レジストリ項目がありません",
        registriesNoItemsSubtitle: "利用可能なスキルをスキャンするソースを選択してください。",
	    editTemplate: "テンプレートを編集",
    tokenPlaceholder: "トークン（例: /daily）",
    codingStack: "コーディングスタック",
    codingStackSubtitle: "コーディングセッションに適用",
    voiceStack: "音声スタック",
    voiceStackSubtitle: "Happier Voice に適用",
    profileStacks: "プロフィールスタック",
    profileStacksSubtitle: ({ count }: { count: number }) => `${count}件のプロフィール`,
    profileStackCount: ({ count }: { count: number }) => `${count}件`,
    noProfilesTitle: "プロフィールがありません",
    noProfilesSubtitle: "プロフィールスタックを使うにはプロフィールを作成してください。",
    stackEntries: "スタック項目",
    stackPlacementSkill: "スキル指示",
    stackPlacementComposer: "コンポーザーに挿入",
    stackPlacementSystem: "システムに追加",
    stackEmptyTitle: "このスタックは空です",
    stackEmptySubtitle: "プロンプトやスキルを追加して開始します。",
    actions: "操作",
    addToStack: "スタックに追加",
    stackAlreadyContainsPrompt: "このスタックには既にその項目があります。",
    stackPickerNoPrompts: "プロンプトがありません。",
    stackPickerNoSkills: "スキルがありません。",
    removeFromStack: "スタックから削除しますか？",
    removeFromStackConfirm: "この項目をスタックから削除します。",
    deleteTemplate: "テンプレートを削除しますか？",
    deleteTemplateConfirm: "テンプレートを削除します。",
    templateTokenReserved: "そのトークンは予約されています。",
    templateTokenConflictsWithAction: "そのトークンは組み込みアクションと競合します。",
    templateTokenDuplicate: "そのトークンは既に使用されています。",
    templateTarget: "対象プロンプト",
    templateBehavior: "動作",
    templateBehaviorInsert: "挿入",
    templateBehaviorInsertOnSend: "送信時に挿入",
    templateBehaviorInsertAndSend: "挿入して送信",
    templateAllowArgs: "引数を許可",
    templateAllowArgsSubtitle: "有効にすると、トークン後のテキストが $args として渡されます。",
        ...promptLibraryUxRefinementTranslationExtension.ja,
  },

  runs: {
    title: "実行",
    empty: "実行はまだありません。",
    showFinished: "完了した実行を表示",
    unknownMachine: "不明なマシン",
    failedToLoad: "実行の読み込みに失敗しました",
    noMachinesAvailable: "利用可能なマシンがありません。",
    groupLabel: ({ groupId }: { groupId: string }) => `グループ ${groupId}`,
    serverTitle: ({ serverId }: { serverId: string }) => `サーバー ${serverId}`,
    machinesSubtitle: "マシン",
    openMachine: "マシンを開く",
    a11y: {
      toggleFinished: "完了した実行の表示を切り替え",
      refresh: "実行を更新",
    },
    openSession: "セッションを開く",
    sessionTitle: ({ sessionId }: { sessionId: string }) => `セッション ${sessionId}`,
    runLabel: ({ runId }: { runId: string }) => `実行 ${runId}`,
    detail: {
      pid: ({ pid }: { pid: number }) => `PID ${pid}`,
      cpu: ({ percent }: { percent: string }) => `${percent}% CPU`,
      memory: ({ megabytes }: { megabytes: number }) => `${megabytes} MB`,
    },
    runDetails: {
      failedToLoad: "実行を読み込めませんでした",
      latestToolResultTitle: "最新のツール結果",
      a11y: {
        refreshRun: "実行を更新",
      },
    },
    stop: {
      stopRunA11y: "実行を停止",
      stopLabel: "実行を停止",
      stoppingLabel: "停止中…",
      stopRunFailedTitle: "実行の停止に失敗しました",
      stopRunFailedBody:
        "セッションRPCでこの実行を停止できませんでした。代わりにセッション全体のプロセスを停止しますか？これは破壊的で、そのセッション内のすべての実行が停止します。",
      stopSession: "セッションを停止",
      failedToStopRun: "実行を停止できませんでした",
      failedToStopSession: "セッションを停止できませんでした",
    },
    send: {
      placeholder: "実行に送信…",
      a11y: {
        sendToRun: "実行に送信",
      },
      sendLabel: "送信",
      sendingLabel: "送信中…",
      failedToSend: "送信に失敗しました",
    },
    delivery: {
      title: "送信方法",
      cardDelivery: ({ label }: { label: string }) => `送信方法: ${label}`,
      steerLabel: "誘導",
      steerHelp:
        "実行がビジーの間に誘導メッセージを送信します（対応している場合）。",
      interruptLabel: "割り込み",
      interruptHelp:
        "現在のターンをキャンセルしてから、新しいターンとしてメッセージを送信します。",
      promptLabel: "プロンプト",
    },
  },

  sessionLog: {
    title: "セッションログ",
    devModeRequiredTitle: "開発者モードが必要です",
    devModeRequiredBody:
      "セッションログを表示するには、設定で開発者モードを有効にしてください。",
    logPathTitle: "ログパス",
    unavailable: "利用できません",
    logPathCopyLabel: "セッションログのパス",
    refreshTailTitle: "ログ末尾を更新",
    refreshTailSubtitle: ({ maxBytes }: { maxBytes: string }) =>
      `末尾の${maxBytes}バイトを読み込み`,
    copyVisibleTitle: "表示中のログをコピー",
    copyVisibleSubtitleLoaded:
      "現在の末尾をクリップボードにコピー",
    copyVisibleSubtitleEmpty: "ログが読み込まれていません",
    copyLogLabel: "セッションログ",
    statusTitle: "ログの状態",
    readErrorTitle: "読み取りエラー",
    tailTitle: "ログ末尾",
    tailTitleTruncated: "ログ末尾（切り詰め）",
    noOutputYet: "（まだログ出力がありません）",
    readFailed: "セッションログの読み取りに失敗しました",
  },

  automations: {
    list: {
      interval: ({ minutes, timezone }: { minutes: number; timezone: string | null }) => `${minutes}分ごと${timezone ? `（${timezone}）` : ""}`,
      cron: ({ expression, timezone }: { expression: string | null; timezone: string | null }) => `Cron${expression ? `: ${expression}` : ""}${timezone ? `（${timezone}）` : ""}`,
      schedule: "スケジュール",
      event: ({ eventId }: { eventId: string }) => `イベント: ${eventId}`,
      manual: "手動",
      conversationTrigger: "会話トリガー",
      noNextRun: "次回の実行なし",
      nextRun: ({ time }: { time: string }) => `次回: ${time}`,
      nextRunPending: "次回の実行は保留中",
    },
    openA11y: "オートメーションを開く",
    gate: {
      disabledTitle: "オートメーションは無効です",
      disabledBody:
        "設定から有効にし、次に「実験」と「オートメーション」をオンにしてください。",
    },
    edit: {
      title: "オートメーションを編集",
      saveAutomationLabel: "オートメーションを保存",
      messageLabel: "メッセージ",
      messagePlaceholder: "送信するメッセージ",
      messageHelpText:
        "このメッセージは、保留中のユーザーメッセージとしてセッションにキューされます。",
      updateFailed: "オートメーションの更新に失敗しました。",
      loadTemplateFailed: "オートメーションテンプレートの読み込みに失敗しました。",
    },
    form: {
      groupAutomationTitle: "オートメーション",
      groupScheduleTitle: "スケジュール",
      toggleEnableTitle: "オートメーションを有効化",
      toggleEnableSubtitle:
        "この新しいセッションテンプレートを、すぐに開始する代わりにスケジュールされたオートメーションとして作成します。",
      toggleEnabledTitle: "有効",
      toggleEnabledSubtitle:
        "無効にすると、スケジュールされた実行は行われません。",
      labels: {
        name: "名前",
        descriptionOptional: "説明（任意）",
        everyMinutes: "間隔（分）",
        cronExpression: "CRON 式",
        timezoneOptional: "タイムゾーン（任意）",
      },
      placeholders: {
        name: "最近のアクティビティを要約",
        description: "自分用のメモ",
        everyMinutes: "60",
        cronExpression: "*/5 * * * *",
        timezone: "UTC または America/New_York",
      },
      schedule: {
        intervalTitle: "間隔",
        intervalSubtitle: "N 分ごとに実行します。",
        cronTitle: "Cron 式",
        cronSubtitle: "高度なスケジュール式。",
        cronHelpText: "標準の 5 フィールド cron: 分 時 日 月 曜日。",
      },
      sentence: {
        run: "実行",
        every: "間隔",
        onSchedule: "スケジュール",
        runEvery: "実行間隔",
        minutes: "分",
        presets: "プリセット",
        intervalUnits: {
          minutes: "分",
          hours: "時間",
          days: "日",
        },
        cronFieldGuide: {
          minute: "分",
          hour: "時",
          dayOfMonth: "日",
          month: "月",
          weekday: "曜日",
        },
        useCron: "Cron 式を使用",
        useInterval: "間隔に切り替え",
        addNotes: "メモを追加",
        notes: "メモ",
        localTimezone: "ローカル時刻",
        scheduleControlA11y: "オートメーションのスケジュールを編集",
        intervalValue: ({ minutes }: { minutes: number }) => {
          if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)} 日`;
          if (minutes === 60) return "1 時間";
          if (minutes % 60 === 0) return `${minutes / 60} 時間`;
          return `${minutes} 分`;
        },
        intervalCadence: ({ minutes }: { minutes: number }) => {
          if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)} 日ごと`;
          if (minutes === 60) return "1 時間ごと";
          if (minutes % 60 === 0) return `${minutes / 60} 時間ごと`;
          return `${minutes} 分ごと`;
        },
        cronPresets: {
          weekdays9am: "平日 9:00",
          hourly: "毎時",
          monday9am: "月曜 9:00",
          dailyMidnight: "毎日 0:00",
        },
        cronCadences: {
          weekdays9am: "平日 9:00",
          hourly: "毎時",
          monday9am: "月曜 9:00",
          dailyMidnight: "毎日 0:00",
        },
        cronCadenceExpression: ({ expression }: { expression: string }) => `cron スケジュール ${expression}`,
        timezone: ({ timezone }: { timezone: string }) => `タイムゾーン: ${timezone}`,
      },
    },
    session: {
      emptyTitle: "オートメーションはありません",
      emptyBody:
        "このセッションにスケジュールされたメッセージをキューするには、オートメーションを追加してください。",
      addAutomation: "オートメーションを追加",
      failedToLoad: "オートメーションの読み込みに失敗しました。",
    },
    screen: {
      emptyTitle: "まだオートメーションはありません",
      emptyBody:
        "「新しいセッション」フローから作成して、マシン上でスケジュールされたセッションを実行できます。",
      createAutomationA11y: "オートメーションを作成",
    },
    detail: {
      invalidId: "無効なオートメーションIDです。",
      notFound: "オートメーションが見つかりません。",
      unknownDate: "不明",
      notScheduled: "未スケジュール",
      overviewGroupTitle: "概要",
      overview: {
        nameTitle: "名前",
        scheduleTitle: "スケジュール",
        statusTitle: "状態",
        nextRunTitle: "次の実行",
      },
      status: {
        active: "有効",
        paused: "一時停止",
      },
      event: {
        watcherTitle: "イベント監視",
        watcherUnwatched: "監視なし",
      },
      actionsGroupTitle: "操作",
      runNowTitle: "今すぐ実行",
      runNowQueuedBadge: "キュー済み",
      runNowQueuedLine: "キューに追加しました。",
      runNowQueuedSubtitle:
        "キュー済み。割り当てられたデーモンが利用可能になり次第処理します。",
      pauseAutomation: "オートメーションを一時停止",
      resumeAutomation: "オートメーションを再開",
      editAutomation: "オートメーションを編集",
      deleteAutomation: "オートメーションを削除",
      deleteConfirmTitle: "オートメーションを削除",
      deleteConfirmMessage:
        "このオートメーションとスケジュールは削除されます。",
      deleteConfirmButton: "削除",
      machineAssignmentsTitle: "マシン割り当て",
      machineAssignmentsFooter:
        "このオートメーションを実行するには、少なくとも1台のマシンを有効にしてください。",
      refreshFailed: "オートメーションの更新に失敗しました。",
      runFailed: "オートメーションの実行に失敗しました。",
      deleteFailed: "オートメーションの削除に失敗しました。",
      assignmentsUpdateFailed: "マシン割り当ての更新に失敗しました。",
      recentRunsTitle: "最近の実行",
      loadMoreRuns: "さらに実行を読み込む",
      runMeta: {
        originTitle: "発生元",
        origin: {
          scheduled: "スケジュール",
          manual: "手動",
          pluginEvent: "イベント",
          conversation: "会話",
        },
        occurred: ({ time }: { time: string }) => `発生: ${time}`,
        invoked: ({ time }: { time: string }) => `呼び出し: ${time}`,
        admitted: ({ time }: { time: string }) => `受付: ${time}`,
        occurrenceTitle: "発生 ID",
        sourceTitle: "監視ソース",
        scheduled: ({ time }: { time: string }) => `スケジュール: ${time}`,
        updated: ({ time }: { time: string }) => `更新: ${time}`,
        error: ({ message }: { message: string }) => `エラー: ${message}`,
      },
      runDetail: {
        title: "受理済みの詳細",
        recipe: "受理済みレシピ",
        recipeAbsent: "受理済みの非公開詳細は記録されていません。",
        templateVersion: "テンプレートのバージョン",
        event: "イベント",
        conversation: "会話",
        sourceInstance: "ソースインスタンス",
        filter: "フィルター",
        filterMatched: "一致",
        payload: "ペイロード",
        input: "入力",
        target: "固定された対象",
        outputCeiling: "出力上限",
        existingSession: ({ sessionId }: { sessionId: string }) => `既存のセッション: ${sessionId}`,
        newSession: ({ machineId, directory }: { machineId: string; directory: string }) => `${machineId} 上の新しいセッション: ${directory}`,
        executionRun: ({ permissionMode }: { permissionMode: string }) => `実行ラン · ${permissionMode}`,
        prompt: "固定されたプロンプト",
        result: "最終結果",
        resultAbsent: "最終結果は記録されていません。",
        failureDetail: "失敗の詳細",
        failureDetailAbsent: "非公開の失敗詳細は記録されていません。",
        predecessorSummary: "前世代の要約はありますが、この詳細では読み取れません。",
        currentnessUnavailable: "アカウント暗号化の変更中は、実行の非公開詳細を一時的に利用できません。",
        materialUnavailable: "このデバイスには現在のアカウント暗号化キーがありません。",
        modeMismatch: "保持された非公開詳細は別のアカウント暗号化モードを使用しています。",
        contentInvalid: "保持された非公開詳細は無効です。",
        invalidTemplate: "受理済みテンプレートは無効です。この実行は送信も再試行もされません。",
        outcomeUnknown: "送信結果は不明です。Happier は固定された対象を再送しません。",
      },
    },
    create: {
      defaultName: "スケジュール済みメッセージ",
      createFailed: "オートメーションの作成に失敗しました。",
      unavailableGroupTitle: "利用できません",
      cannotCreateForSession: "このセッションではオートメーションを作成できません",
      sessionNotFound: "セッションが見つかりません。",
      missingMachineId: "このセッションにはマシンIDがありません。",
      missingResumeKey:
        "このセッションでは再開用の暗号化キーがまだ読み込まれていません。",
      createButtonTitle: "オートメーションを作成",
    },
  },

  appCrash: {
    title: "問題が発生しました",
    subtitle:
      "Happierで予期しないエラーが発生しました。アプリUIを再起動するか、サポート用に詳細をコピーできます。",
    detailsTitle: "エラーの詳細",
    restart: "アプリを再起動",
    restartAndReportIssue: "再起動して不具合を報告",
    copyDetails: "エラー詳細をコピー",
  },

  webCryptoGate: {
    title: "安全な接続が必要です",
    subtitle:
      "このページはデータを安全に保つためにWebCryptoが必要です。ブラウザはセキュアコンテキスト（HTTPS/localhost）以外ではWebCryptoを利用できません。",
    howToFix: "解決方法",
    fixHttps: "HTTPSでUIを開いてください（推奨）。",
    fixTunnel: "LANからアクセスする場合は、HTTPSトンネルまたはTLS付きのリバースプロキシを使用してください。",
    fixLocalhost:
      "同じマシンで開いている場合は http://localhost を使用してください（ループバックはセキュアとして扱われます）。",
    currentOrigin: "現在のオリジン",
    secureContext: "セキュアコンテキスト",
    copyDetails: "詳細をコピー",
    reload: "再読み込み",
  },

  common: {
    // Simple string constants
    add: "追加",
    edit: "編集",
    duplicate: "複製",
    actions: "操作",
    moreActions: "その他の操作",
    moreActionsHint: "追加の操作メニューを開きます",
    destructiveActionHint: "この操作は破壊的で、元に戻せません。",
    cancel: "キャンセル",
    submit: "送信",
    close: "閉じる",
      open: "開く",
      done: "完了",
      reorder: "並べ替え",
      moveUp: "上に移動",
      moveDown: "下に移動",
      authenticate: "認証",
      save: "保存",
		    error: "エラー",
		    success: "成功",
		    warning: "警告",
		    info: "情報",
		    comingSoon: "近日公開",
    ok: "了解",
		    continue: "続行",
		    back: "戻る",
        previous: "前へ",
        next: "次へ",
	    start: "開始",
	    run: "実行",
	    create: "作成",
    rename: "名前を変更",
    remove: "削除",
    update: "更新",
    commit: "コミット",
    history: "履歴",
    applied: "適用済み",
    signOut: "サインアウト",
    keep: "保持",
    use: "使用する",
    reset: "リセット",
    logout: "ログアウト",
    yes: "はい",
    no: "いいえ",
    on: "オン",
    off: "オフ",
    discard: "破棄",
    discardChanges: "変更を破棄",
    unsavedChangesWarning: "未保存の変更があります。",
    keepEditing: "編集を続ける",
    version: "バージョン",
    details: "詳細",
    copied: "コピーしました",
    copy: "コピー",
    copyWithLabel: ({ label }: { label: string }) => `${label} をコピー`,
    paste: "貼り付け",
    pasteImage: "画像を貼り付け",
    expand: "展開",
    collapse: "折りたたむ",
    command: "コマンド",
    scanning: "スキャン中...",
    urlPlaceholder: "https://example.com",
    home: "ホーム",
    message: "メッセージ",
    send: "送信",
    attach: "添付",
    addImage: "画像を追加",
    addFile: "ファイルを追加",
    linkFile: "ファイルをリンク",
    files: "ファイル",
    path: "パス",
    fileViewer: "ファイルビューアー",
    loading: "読み込み中...",
    none: "なし",
    notProvided: "未提供",
    unavailable: "利用不可",
    dialog: "ダイアログ",
    retry: "再試行",
    or: "または",
    delete: "削除",
    deleted: "削除済み",
    optional: "任意",
    noMatches: "一致するものがありません",
    all: "すべて",
    machine: "マシン",
    clearSearch: "検索をクリア",
    refresh: "更新",
    default: "既定",
    enabled: "有効",
    disabled: "無効",
    requestFailed: "リクエストに失敗しました。",
    saveAs: "名前を付けて保存",

    more: "その他",
    skip: "スキップ",
    maximize: "最大化",
    restore: "復元",
    name: "名前",
    blocked: "ブロック",
    active: "アクティブ",
    inactive: "非アクティブ",
    running: "実行中…",
    login: "ログイン",
    install: "インストール",
    enable: "有効化",
    disable: "無効化",
    tabs: "タブ",
    logs: "ログ",
    share: "共有",
    unreachable: "到達不能",},

  ui: {
    resizableDockedPane: {
      resizeA11y: "パネルのサイズを変更",
      resizeHint: "キーボードの矢印キーまたは調整操作でサイズを変更できます",
    },
    modalPane: {
      right: "右サイドバー",
      details: "詳細パネル",
      bottom: "下部パネル",
      dismiss: ({ pane }: { pane: string }) => `${pane}を閉じる`,
    },
    pluginUi: {
      loading: "読み込み中",
      empty: "表示するものはありません",
      error: "問題が発生しました",
      moreActions: "その他の操作",
    },
  },

  dropdown: {
    category: {
      general: "一般",
      results: "結果",
    },
    createItem: {
      prefix: "追加",
    },
  },

  profile: {
    userProfile: "ユーザープロフィール",
    details: "詳細",
    firstName: "名",
    lastName: "姓",
    username: "ユーザー名",
    status: "ステータス",
  },

  profiles: {
    title: "プロファイル",
    subtitle: "セッション用の環境変数プロファイルを管理",
    sessionUses: ({ profile }: { profile: string }) =>
      `このセッションは次を使用しています: ${profile}`,
    profilesFixedPerSession:
      "プロファイルはセッションごとに固定です。別のプロファイルを使うには新しいセッションを開始してください。",
    noProfile: "プロファイルなし",
    noProfileDescription: "デフォルトの環境設定を使用",
    defaultModel: "デフォルトモデル",
    addProfile: "プロファイルを追加",
    profileName: "プロファイル名",
    enterName: "プロファイル名を入力",
    baseURL: "ベースURL",
    authToken: "認証トークン",
    enterToken: "認証トークンを入力",
    model: "モデル",
    tmuxSession: "Tmuxセッション",
    enterTmuxSession: "tmuxセッション名を入力",
    tmuxTempDir: "Tmux一時ディレクトリ",
    enterTmuxTempDir: "一時ディレクトリのパスを入力",
    tmuxUpdateEnvironment: "環境を自動更新",
    nameRequired: "プロファイル名は必須です",
    deleteConfirm: ({ name }: { name: string }) =>
      `プロファイル「${name}」を削除してもよろしいですか？`,
    editProfile: "プロファイルを編集",
    addProfileTitle: "新しいプロファイルを追加",
    builtIn: "組み込み",
    custom: "カスタム",
    builtInSaveAsHint:
      "組み込みプロファイルを保存すると、新しいカスタムプロファイルが作成されます。",
    builtInNames: {
      anthropic: "Anthropic（デフォルト）",
      deepseek: "DeepSeek（推論）",
      zai: "Z.AI (GLM-4.6)",
      codex: "Codex (Default)",
      openai: "OpenAI (GPT-5)",
      azureOpenai: "Azure OpenAI",
      gemini: "Gemini (Default)",
      geminiApiKey: "Gemini (API key)",
      geminiVertex: "Gemini (Vertex AI)",
    },
    groups: {
      favorites: "お気に入り",
      custom: "あなたのプロファイル",
      builtIn: "組み込みプロファイル",
    },
    actions: {
      viewEnvironmentVariables: "環境変数",
      addToFavorites: "お気に入りに追加",
      removeFromFavorites: "お気に入りから削除",
      editProfile: "プロファイルを編集",
      duplicateProfile: "プロファイルを複製",
      deleteProfile: "プロファイルを削除",
    },
    copySuffix: "(コピー)",
    duplicateName: "同じ名前のプロファイルが既に存在します",
    setupInstructions: {
      title: "セットアップ手順",
      viewCloudGuide: "公式セットアップガイドを表示",
    },
    machineLogin: {
      title: "マシンでのログインが必要",
      subtitle:
        "このプロファイルは、選択したマシン上の CLI ログインキャッシュに依存します。",
      status: {
        loggedIn: "ログイン済み",
        notLoggedIn: "未ログイン",
      },
      claudeCode: {
        title: "Claude Code",
        instructions:
          "claude を実行し、/login と入力してログインしてください。",
        warning:
          "注意: ANTHROPIC_AUTH_TOKEN を設定すると CLI ログインを上書きします。",
      },
      codex: {
        title: "Codex",
        instructions: "codex login を実行してログインしてください。",
      },
    },
    requirements: {
      secretRequired: "シークレット",
      configured: "マシンで設定済み",
      notConfigured: "未設定",
      checking: "確認中…",
      missingConfigForProfile: ({ env }: { env: string }) =>
        `このプロファイルを使用するには、マシンで ${env} を設定する必要があります。`,
      modalTitle: "シークレットが必要です",
      modalBody:
        "このプロファイルにはシークレットが必要です。\n\n利用可能な選択肢:\n• マシン環境を使用（推奨）\n• アプリ設定の保存済みシークレットを使用\n• このセッションのみシークレットを入力",
      sectionTitle: "要件",
      sectionSubtitle:
        "これらの項目は事前チェックのために使用され、予期しない失敗を避けます。",
      secretEnvVarPromptDescription:
        "必要な秘密環境変数名を入力してください（例: OPENAI_API_KEY）。",
      modalHelpWithEnv: ({ env }: { env: string }) =>
        `このプロファイルには${env}が必要です。以下から1つ選択してください。`,
      modalHelpGeneric:
        "このプロファイルにはシークレットが必要です。以下から1つ選択してください。",
      chooseOptionTitle: "選択してください",
      machineEnvStatus: {
        theMachine: "マシン",
        checkFor: ({ env }: { env: string }) => `${env} を確認`,
        checking: ({ env }: { env: string }) => `${env} を確認中…`,
        found: ({ env, machine }: { env: string; machine: string }) =>
          `${machine}で${env}が見つかりました`,
        notFound: ({ env, machine }: { env: string; machine: string }) =>
          `${machine}で${env}が見つかりません`,
      },
      machineEnvSubtitle: {
        checking: "デーモン環境を確認中…",
        found: "マシン上のデーモン環境で見つかりました。",
        notFound:
          "マシン上のデーモン環境に設定して、デーモンを再起動してください。",
      },
      options: {
        none: {
          title: "なし",
          subtitle: "シークレットもCLIログインも不要です。",
        },
        machineLogin: {
          subtitle: "ターゲットマシンでCLIからログインしている必要があります。",
          longSubtitle:
            "ターゲットマシンで選択したAIバックエンドのCLIにログインしている必要があります。",
        },
        useMachineEnvironment: {
          title: "マシン環境を使用",
          subtitleWithEnv: ({ env }: { env: string }) =>
            `デーモン環境から${env}を使用します。`,
          subtitleGeneric: "デーモン環境からシークレットを使用します。",
        },
        useSavedSecret: {
          title: "保存済みシークレットを使用",
          subtitle:
            "アプリ内の保存済みシークレットを選択（または追加）します。",
        },
        enterOnce: {
          title: "シークレットを入力",
          subtitle:
            "このセッションのみシークレットを貼り付けます（保存されません）。",
        },
      },
      secretEnvVar: {
        title: "シークレットの環境変数",
        subtitle:
          "このプロバイダがシークレットに期待する環境変数名を入力してください（例: OPENAI_API_KEY）。",
        label: "環境変数名",
      },
      sections: {
        machineEnvironment: "マシン環境",
        useOnceTitle: "一度だけ使用",
        useOnceLabel: "シークレットを入力",
        useOnceFooter:
          "このセッションのみシークレットを貼り付けます。保存されません。",
      },
      actions: {
        useMachineEnvironment: {
          subtitle: "マシンに既にあるキーを使用して開始します。",
        },
        useOnceButton: "一度だけ使用（セッションのみ）",
      },
    },
    defaultPermissionMode: {
      title: "デフォルトの権限モード",
      descriptions: {
        default: "権限を要求する",
        acceptEdits: "編集を自動承認",
        plan: "実行前に計画",
        bypassPermissions: "すべての権限をスキップ",
      },
    },
    defaultPermissions: {
      title: "既定の権限",
      footer:
        "このプロファイルを選択したとき、新規セッションのアカウント既定権限を上書きします。",
      accountDefaultSubtitle: ({ label }: { label: string }) =>
        `アカウントの既定: ${label}`,
      useAccountDefault: "アカウントの既定を使用",
      currently: ({ label }: { label: string }) => `現在: ${label}`,
    },
    defaultStorage: {
      title: "既定のセッションタイプ",
      footer:
        "このプロフィールを選択したとき、新しいセッションに対してアカウント既定の Happier/直接セッションタイプを上書きします。",
      accountDefaultSubtitle: ({ label }: { label: string }) => `アカウント既定: ${label}`,
      useAccountDefault: "アカウント既定を使用",
      currently: ({ label }: { label: string }) => `現在: ${label}`,
    },
    aiBackend: {
      title: "AIバックエンド",
      selectAtLeastOneError:
        "少なくとも1つのAIバックエンドを選択してください。",
      claudeSubtitle: "Claude コマンドライン",
      codexSubtitle: "Codex コマンドライン",
      opencodeSubtitle: "OpenCode コマンドライン",
      geminiSubtitleExperimental: "Gemini コマンドライン（実験）",
      auggieSubtitle: "Auggie CLI",
      qwenSubtitleExperimental: "Qwen Code CLI（実験）",
      kimiSubtitleExperimental: "Kimi CLI（実験）",
      kiloSubtitleExperimental: "Kilo CLI（実験）",
      kiroSubtitleExperimental: "Kiro CLI（実験）",
      customAcpSubtitleExperimental: "カスタム ACP CLI（実験）",
      piSubtitleExperimental: "Pi CLI（実験）",
      copilotSubtitleExperimental: "GitHub Copilot CLI（実験的）",
      cursorSubtitleExperimental: "Cursor Agent CLI（実験的）",

      ohMyPiSubtitleExperimental: "oh-my-pi CLI（実験）",},
    tmux: {
      title: "Tmux",
      spawnSessionsTitle: "Tmuxでセッションを起動",
      spawnSessionsEnabledSubtitle:
        "セッションは新しいtmuxウィンドウで起動します。",
      spawnSessionsDisabledSubtitle:
        "セッションは通常のシェルで起動します（tmux連携なし）",
      isolatedServerTitle: "分離された tmux サーバー",
      isolatedServerEnabledSubtitle:
        "分離された tmux サーバーでセッションを開始します（推奨）。",
      isolatedServerDisabledSubtitle:
        "デフォルトの tmux サーバーでセッションを開始します。",
      sessionNamePlaceholder: "空 = 現在/最近のセッション",
      tempDirPlaceholder: "空欄で自動生成",
    },
    previewMachine: {
      title: "マシンをプレビュー",
      itemTitle: "環境変数のプレビュー用マシン",
      selectMachine: "マシンを選択",
      resolveSubtitle:
        "下の解決後の値をプレビューするためだけに使用します（保存内容は変わりません）。",
      selectSubtitle:
        "下の解決後の値をプレビューするマシンを選択してください。",
    },
    environmentVariables: {
      title: "環境変数",
      addVariable: "変数を追加",
      namePlaceholder: "変数名（例: MY_CUSTOM_VAR）",
      valuePlaceholder: "値（例: my-value または ${MY_VAR}）",
      validation: {
        nameRequired: "変数名を入力してください。",
        invalidNameFormat:
          "変数名は大文字、数字、アンダースコアのみで、数字から始めることはできません。",
        duplicateName: "その変数は既に存在します。",
      },
      card: {
        valueLabel: "値:",
        fallbackValueLabel: "フォールバック値:",
        valueInputPlaceholder: "値",
        defaultValueInputPlaceholder: "デフォルト値",
        fallbackDisabledForVault:
          "シークレット保管庫を使用している場合、フォールバックは無効になります。",
        secretNotRetrieved: "シークレット値 — セキュリティのため取得しません",
        secretToggleLabel: "UIで値を隠す",
        secretToggleSubtitle:
          "UIで値を非表示にし、プレビューのためにマシンから取得しません。",
        secretToggleEnforcedByDaemon: "デーモンで強制",
        secretToggleEnforcedByVault: "シークレット保管庫で強制",
        secretToggleResetToAuto: "自動に戻す",
        requirementRequiredLabel: "必須",
        requirementRequiredSubtitle:
          "変数が不足している場合、セッション作成をブロックします。",
        requirementUseVaultLabel: "シークレット保管庫を使用",
        requirementUseVaultSubtitle:
          "保存済みシークレットを使用（フォールバックなし）。",
        defaultSecretLabel: "デフォルトのシークレット",
        overridingDefault: ({ expectedValue }: { expectedValue: string }) =>
          `ドキュメントのデフォルト値を上書き: ${expectedValue}`,
        useMachineEnvToggle: "マシン環境から値を使用",
        resolvedOnSessionStart:
          "選択したマシンでセッション開始時に解決されます。",
        sourceVariableLabel: "参照元変数",
        sourceVariablePlaceholder: "参照元変数名（例: Z_AI_MODEL）",
        checkingMachine: ({ machine }: { machine: string }) =>
          `${machine} を確認中...`,
        emptyOnMachine: ({ machine }: { machine: string }) =>
          `${machine} では空です`,
        emptyOnMachineUsingFallback: ({ machine }: { machine: string }) =>
          `${machine} では空です（フォールバック使用）`,
        notFoundOnMachine: ({ machine }: { machine: string }) =>
          `${machine} で見つかりません`,
        notFoundOnMachineUsingFallback: ({ machine }: { machine: string }) =>
          `${machine} で見つかりません（フォールバック使用）`,
        valueFoundOnMachine: ({ machine }: { machine: string }) =>
          `${machine} で値を確認`,
        differsFromDocumented: ({ expectedValue }: { expectedValue: string }) =>
          `ドキュメント値と異なります: ${expectedValue}`,
      },
      preview: {
        secretValueHidden: ({ value }: { value: string }) =>
          `${value} - セキュリティのため非表示`,
        hiddenValue: "***非表示***",
        emptyValue: "(空)",
        sessionWillReceive: ({
          name,
          value,
        }: {
          name: string;
          value: string;
        }) => `セッションに渡される値: ${name} = ${value}`,
      },
      previewModal: {
        titleWithProfile: ({ profileName }: { profileName: string }) =>
          `環境変数 · ${profileName}`,
        descriptionPrefix:
          "これらの環境変数はセッション開始時に送信されます。値はデーモンが",
        descriptionFallbackMachine: "選択したマシン",
        descriptionSuffix: "で解決します。",
        emptyMessage: "このプロファイルには環境変数が設定されていません。",
        checkingSuffix: "(確認中…)",
        detail: {
          fixed: "固定",
          machine: "マシン",
          checking: "確認中",
          fallback: "フォールバック",
          missing: "未設定",
        },
      },
    },
    delete: {
      title: "プロファイルを削除",
      message: ({ name }: { name: string }) =>
        `「${name}」を削除してもよろしいですか？この操作は元に戻せません。`,
      confirm: "削除",
      cancel: "キャンセル",
    },
  },

  status: {
    connected: "接続済み",
    connecting: "接続中",
    disconnected: "切断済み",
    error: "エラー",
    online: "オンライン",
    working: "作業中...",
    workingRetained: "作業中、更新待ち…",
        backgroundActive: 'バックグラウンドで作業中',
        workingExternally: '外部で作業中',
        needsInputExternally: '外部で入力待ち',
        retryingExternally: '外部で再試行中',
        ready: '準備完了',
        recentlyActive: '最近アクティブ',
        externalStatusUnknown: '外部ステータス不明',
    readyForReview: "レビュー準備完了",
    canceled: "キャンセル済み",
    offline: "オフライン",
    lastSeen: ({ time }: { time: string }) => `最終アクセス: ${time}`,
    actionRequired: "操作が必要",
    waitingForYourResponse: "回答を待っています",
    permissionRequired: "権限が必要です",
    activeNow: "アクティブ",
    unknown: "不明",
  },

	  connectionStatus: {
	    title: "接続",
	    labels: {
	      server: "サーバー",
	      socket: "ソケット",
	      authenticated: "認証済み",
	      lastSync: "最終同期",
	      nextRetry: "次の再試行",
	      lastError: "直近のエラー",
	    },
	  },

  time: {
    justNow: "たった今",
    minutesAgo: ({ count }: { count: number }) => `${count}分前`,
    hoursAgo: ({ count }: { count: number }) => `${count}時間前`,
    nowShort: "今",
    minutesAgoShort: ({ count }: { count: number }) => `${count}分前`,
    hoursAgoShort: ({ count }: { count: number }) => `${count}時間前`,
    daysAgoShort: ({ count }: { count: number }) => `${count}日前`,
  },
  commandMenu: {
    empty: '結果がありません',
  },


  selectionList: {
    emptyMatch: "一致するものがありません",
    clearInput: "クリア",
    backTo: ({ label }: { label: string }) => `${label}に戻る`,
    dynamicSectionError: "問題が発生しました",
    pathNotFound: "パスが見つかりません",
    backShortcut: "戻る",
  },

  connect: {
    restoreAccount: "アカウントを復元",
    enterSecretKey: "シークレットキーを入力してください",
    invalidSecretKey:
      "シークレットキーが無効です。確認して再試行してください。",
    enterUrlManually: "URLを手動で入力",
    scanComputerQrUnavailableTitle: "PCのQRスキャンは利用できません",
    scanComputerQrUnavailableBody:
      "このサーバーではこのサインイン方法が無効になっています。下の別の方法でアカウントを復元してください。",
    scanComputerQrInstructions: "パソコンの Happier（設定 → スマホを追加）に表示されたQRコードをスキャンします。",
    scanComputerQrButton: "QRをスキャンしてサインイン",
    waitingForApproval: "承認待ち…",
    showQrInstead: "代わりにQRコードを表示",
    addPhoneQrInstructions: "Happier モバイルアプリでこのQRコードをスキャンして、スマホでサインインします。",
    serverUrlNotEmbeddedTitle: "スマホでサーバーを設定",
    serverUrlNotEmbeddedBody:
      "このQRコードにはサーバーのURLを含められません（localhost に設定されているため）。スマホで「設定 → サーバー」を開き、スマホから到達できるURL（LANのIPやTailscaleのURLなど）を追加してから、もう一度スキャンしてください。",
    pairingRequestTitle: "ペアリング要求",
    pairingRequestBody: "スマホに表示されたコードと一致することを確認してから承認してください。",
    pairingAlreadyRequestedTitle: "コードは使用済みです",
    pairingAlreadyRequestedBody:
      "このQRコードは別の端末で既にスキャンされています。パソコン側で新しいコードを生成してください。",
    deviceLabel: "デバイス",
    confirmCodeLabel: "確認コード",
    approveButton: "承認",
    generateNewQrCode: "新しいQRコードを生成",
    pairingQrExpired: "このQRコードは期限切れです。新しいコードを生成してください。",
    openMachine: "マシンを開く",
    terminalUrlPlaceholder: "happier://terminal?...",
    accountUrlPlaceholder: "happier:///account?...",
    restoreQrInstructions:
      "すでにサインインしている端末で、設定 → アカウント に移動してこのQRコードをスキャンしてください。",
    externalAuthVerifiedTitle: ({ provider }: { provider: string }) =>
      `${provider} の認証が完了しました`,
    externalAuthVerifiedBody: ({ provider }: { provider: string }) =>
      `${provider} に紐づく既存の Happier アカウントが見つかりました。この端末でサインインを完了するには、QRコードまたはシークレットキーでアカウントキーを復元してください。`,
    restoreWithSecretKeyInstead: "秘密鍵で復元する",
    restoreWithSecretKeyDescription:
      "アカウントへのアクセスを復元するには秘密鍵を入力してください。",
    lostAccessLink: "アクセスを失いましたか？",
    lostAccessTitle: "アカウントへのアクセスを失いましたか？",
    lostAccessBody:
      "このアカウントに紐づいた端末がなく、シークレットキーを失った場合は、本人確認プロバイダーでアカウントをリセットできます。新しい Happier アカウントが作成されます。以前の暗号化された履歴は復元できません。",
    lostAccessContinue: ({ provider }: { provider: string }) =>
      `${provider} で続行`,
    lostAccessConfirmTitle: "アカウントをリセットしますか？",
    lostAccessConfirmBody:
      "新しいアカウントを作成し、プロバイダーのIDを再リンクします。以前の暗号化された履歴は復元できません。",
    lostAccessConfirmButton: "リセットして続行",
    secretKeyPlaceholder: "XXXXX-XXXXX-XXXXX...",
    secretKeyInputLabel: "シークレットキー",
    linkNewDeviceTitle: "新しいデバイスをリンク",
    linkNewDeviceSubtitle: "新しいデバイスに表示されているQRコードをスキャンしてこのアカウントにリンクしてください",
    linkNewDeviceQrInstructions: "新しいデバイスでHappierを開いてQRコードを表示してください",
    scanQrCodeOnDevice: "QRコードをスキャン",
    unsupported: {
      connectTitle: ({ name }: { name: string }) => `${name} を接続`,
      runCommandInTerminal: "ターミナルで次のコマンドを実行してください:",
      runCommandInTerminalWithCommand: ({ command }: { command: string }) =>
        `ターミナルで次のコマンドを実行してください:\n\n${command}`,
      command: ({ name }: { name: string }) => `happier connect ${name}`,
    },
  },

  bugReports: {
    composer: {
      alerts: {
        previewUnavailableTitle: "プレビューできません",
        previewUnavailableBody: "診断プレビューを作成できませんでした。",
        submittedTitle: "バグレポートを送信しました",
        submittedExistingIssueBody: ({ issueNumber, reportId }: { issueNumber: number; reportId: string }) =>
          `Issue #${issueNumber} にコメントを投稿しました。\n\nレポートID: ${reportId}`,
        submittedNewIssueBody: ({ issueNumber, reportId }: { issueNumber: number; reportId: string }) =>
          `Issue #${issueNumber} を作成しました。\n\nレポートID: ${reportId}`,
        submitFailedTitle: "送信に失敗しました",
        submitFailedFallbackMessage: "このレポートを送信できませんでした。",
        submitFailedBody: ({ message }: { message: string }) =>
          `${message}\n\n代わりに、事前入力済みの GitHub Issue を開きますか？`,
        openFallbackIssueButton: "代替Issueを開く",
      },
      diagnostics: {
        title: "診断",
        subtitle: "含める内容を選択し、送信前にプレビューできます。",
        includeTitle: "診断を含める",
        includeSubtitle:
          "迅速な診断のため、サニタイズ済みのデバッグ資料を添付します。",
        disabledByServerSuffix: "（サーバーにより無効）",
        pasteDoctorJson: {
          title: "CLI doctor JSON（任意）",
          subtitle:
            "UIからマシンに接続できない場合、PCで happier doctor --json を実行してここに貼り付けてください。",
          placeholder: '{ "capturedAt": "...", ... }',
          invalid: ({ error }: { error: string }) => `無効な doctor JSON: ${error}`,
          valid: "doctor JSON は有効に見えます。レポートに添付されます。",
        },
        previewButton: "診断をプレビュー",
        preview: {
          title: "診断プレビュー",
          helper:
            "これらのアーティファクトはレポートと一緒にアップロードされます（サニタイズ済み・サイズ制限あり）。項目をタップして内容を全文表示します。",
          empty: "送信される診断アーティファクトはありません。",
          openArtifactA11y: ({ filename }: { filename: string }) =>
            `「${filename}」を開く`,
        },
        kinds: {
          app: {
            title: "アプリ診断",
            detail:
              "アプリのコンソールログ、最近の操作、セッション要約。",
          },
          daemon: {
            title: "デーモン診断",
            detail:
              "デーモンの要約と、選択したマシンからの最近のデーモンログ。",
          },
          stackService: {
            title: "Stack サービス診断",
            detail: "Stack のコンテキストと最近の Stack ログ（利用可能な場合）。",
          },
          server: {
            title: "サーバー診断",
            detail: "現在アクティブなサーバーのスナップショット。",
          },
        },
      },
      issueDetails: {
        title: "問題の説明",
        subtitle:
          "再現と診断ができるよう、十分な情報を記入してください。",
        titleLabel: "タイトル（必須）",
        titlePlaceholder: "短いタイトル",
        githubUsernameLabel: "GitHub ユーザー名（任意）",
        githubUsernamePlaceholder: "issue 本文の連絡先として使用されます",
        summaryLabel: "簡潔な要約（必須）",
        summaryPlaceholder: "1 段落の要約",
        currentBehaviorLabel: "現在の挙動（任意）",
        currentBehaviorPlaceholder: "実際には何が起きますか？",
        expectedBehaviorLabel: "期待する挙動（任意）",
        expectedBehaviorPlaceholder: "代わりにどうなるべきですか？",
        reproductionStepsLabel: "再現手順（任意）",
        reproductionStepsPlaceholder:
          "1. Happier を開く\n2. セッションを開始\n3. ...",
        whatChangedLabel: "最近の変更点（任意）",
        whatChangedPlaceholder:
          "アップデート、設定変更、新しいセットアップ手順…",
      },
      similarIssues: {
        title: "重複の可能性",
        subtitle:
          "一致するものがあれば、新しい Issue を開く代わりにコメントとして投稿できます。",
        searching: "Issue を検索中…",
        selectedTitle: ({ number }: { number: number }) => `Issue #${number} を使用中`,
        selectedSubtitle: "タップして新しい Issue の作成に戻ります。",
        useIssueA11y: ({ number }: { number: number }) => `Issue #${number} を使用`,
        issueState: {
          open: "オープン中の Issue",
          closed: "クローズ済みの Issue",
        },
      },
      frequencySeverity: {
        title: "頻度と重大度",
        frequencyLabel: "頻度",
        severityLabel: "重大度",
        frequency: {
          always: "常に",
          often: "よくある",
          sometimes: "ときどき",
          once: "一度だけ",
        },
        severity: {
          blocker: "致命的",
          high: "高",
          medium: "中",
          low: "低",
        },
      },
      environment: {
        title: "環境（編集可）",
        appVersionLabel: "アプリ版本",
        platformLabel: "プラットフォーム",
        osVersionLabel: "OS バージョン",
        deviceModelLabel: "デバイスモデル",
        serverUrlLabel: "サーバー URL",
        serverVersionLabel: "サーバー版本（任意）",
        deploymentTypeLabel: "デプロイ種別",
        deploymentType: {
          cloud: "クラウド",
          selfHosted: "セルフホスト",
          enterprise: "エンタープライズ",
        },
      },
      consent: {
        title: "同意",
        understandTitle:
          "診断には技術メタデータが含まれる場合があることを理解しました",
        understandSubtitle:
          "パスワード、アクセストークン、秘密鍵は含めないでください。",
      },
      submit: {
        requiredFieldsHint: "必須項目を入力すると送信できるようになります。",
        submitting: "送信中…",
        addToIssue: ({ number }: { number: number }) => `Issue #${number} に追加`,
        submitNew: "バグレポートを送信",
      },
    },
  },

  memorySearchSettings: {
    disabled: {
      footer: "機能でメモリ検索を有効にして、ローカルのインデックスを設定できます。",
      title: "メモリ検索は無効です",
      subtitle: "設定 → 機能 から memory.search を有効にしてください",
      openFeatureSettings: "機能設定を開く",
      alertTitle: "メモリ検索が無効です",
      alertBody: "設定 → 機能 で memory.search を有効にしてください。",
    },
    enabled: {
      title: "有効",
      subtitle: "このマシン上でローカルインデックスを構築・維持します",
      footer:
        "有効にすると、Happier は復号されたトランスクリプトから端末内インデックスを作成し、すばやい想起と検索を可能にします。",
    },
    budgets: {
      groupTitle: "ディスク予算",
      groupFooter:
        "ローカルのメモリ索引が使用できるディスク容量を制限します（可能な範囲で削除します）。",
      mbLabel: ({ mb }: { mb: number }) => `${mb} MB`,
      lightTitle: "ライト索引の予算",
      lightPromptTitle: "ライト索引の予算",
      lightPromptBody:
        "この端末のライト（要約シャード）索引の最大MB。",
      deepTitle: "ディープ索引の予算",
      deepPromptTitle: "ディープ索引の予算",
      deepPromptBody: "この端末のディープ（チャンク）索引の最大MB。",
    },
    privacy: {
      groupTitle: "プライバシー",
      groupFooter:
        "メモリ検索を無効にしたときに、ローカルの派生インデックスとモデルキャッシュを削除します。",
      deleteOnDisableTitle: "無効化時に削除",
      deleteOnDisableSubtitle:
        "メモリ検索をオフにしたときにローカルのインデックスとキャッシュを削除します",
    },
    screen: {
      machineLabel: ({ machine }: { machine: string }) => `マシン: ${machine}`,
      searchPlaceholder: "メモリを検索",
      enableLocalSearch: "ローカルメモリ検索を有効化",
      emptyResults: "まだメモリ結果はありません",
    },
        status: {
            title: "ローカルインデックスの状態",
            diskUsageTitle: "ディスク使用量",
            disabled: "このマシンではローカルメモリ検索は無効です",
            empty: "ローカルメモリ検索は有効ですが、検索可能な内容はまだインデックス化されていません",
            indexing: "ローカルメモリ検索がトランスクリプト内容をインデックス化しています",
            waiting: "ローカルメモリ検索は次のインデックス実行を待機しています",
            error: "ローカルメモリ検索に注意が必要です",
            readyLight: "このマシンでライトインデックスが準備完了",
            readyDeep: "このマシンでディープインデックスが準備完了",
            unavailableLight: "このマシンではライトインデックスがまだ準備できていません",
            unavailableDeep: "このマシンではディープインデックスがまだ準備できていません",
            diskUsage: ({ lightMb, deepMb }: { lightMb: number; deepMb: number }) => `Light ${lightMb} MB · Deep ${deepMb} MB`,
            diskUsageFormatted: ({ light, deep }: { light: string; deep: string }) => `Light ${light} · Deep ${deep}`,
            diskUsageUnavailable: "ディスク使用量は利用できません",
            ...memoryEmbeddingsTranslationExtension.status,
        },
    machine: {
      title: "マシン",
      changeTitle: "マシンを変更",
      noMachine: "マシンなし",
    },
    indexMode: {
      title: "インデックスモード",
      footer:
        "ライトモードは小さな要約シャードのみを保存します。ディープモードはより多く見つけられますが、ディスクを多く使用します。",
      triggerTitle: "モード",
      options: {
        lightTitle: "ライト（おすすめ）",
        lightSubtitle: "要約シャードのみ",
        deepTitle: "ディープ",
        deepSubtitle: "メッセージのチャンクをローカルでインデックス化",
      },
    },
    backfill: {
      title: "バックフィル",
      footer:
        "ローカルメモリを有効化したときに、どこまで履歴をインデックス化するかを設定します。",
      triggerTitle: "ポリシー",
      options: {
        newOnlyTitle: "新規のみ（おすすめ）",
        newOnlySubtitle: "有効化以降に作成された内容のみをインデックス化",
        last30DaysTitle: "過去30日",
        last30DaysSubtitle: "最近のセッションをバックフィル",
        allHistoryTitle: "全履歴",
        allHistorySubtitle: "すべてをバックフィル（時間がかかる場合があります）",
      },
    },
    indexContents: {
      groupTitle: "インデックス内容",
      title: "検索可能な内容",
      subtitle: ({ sessions, lightShards, deepChunks }: { sessions: number; lightShards: number; deepChunks: number }) =>
        `${sessions} セッション · ${lightShards} ライトシャード · ${deepChunks} ディープチャンク`,
    },
    queue: {
      groupTitle: "バックフィルとキュー",
      title: "インデックスキュー",
      subtitle: ({ selected, queued, indexing, indexed, empty, failed, waiting }: { selected: number; queued: number; indexing: number; indexed: number; empty: number; failed: number; waiting: number }) =>
        `${selected} 選択 · ${queued} キュー中 · ${indexing} インデックス中 · ${indexed} 完了 · ${empty} 空 · ${failed} 失敗 · ${waiting} 待機`,
      workerPhase: ({ phase }: { phase: string }) => `現在のフェーズ: ${phase}`,
    },
    lastRun: {
      groupTitle: "最後のインデックス実行",
      title: "最後の実行",
      subtitle: ({ considered, processed, semanticRows, failures }: { considered: number; processed: number; semanticRows: number; failures: number }) =>
        `${considered} 件対象 · ${processed} 件処理 · ${semanticRows} セマンティック行 · ${failures} 件失敗`,
    },
    coverage: {
      title: "内容の範囲",
      footer: "選択したセッション内でどのセマンティックなトランスクリプト内容をインデックス化するかを制御します。",
      triggerTitle: "範囲",
      options: {
        fullTitle: "選択した全履歴",
        fullSubtitle: "選択したユーザーとアシスタントのすべてのメッセージをインデックス化",
        latestMessagesTitle: "最新メッセージ",
        latestMessagesSubtitle: "セッションごとに最近のセマンティックメッセージ数を制限してインデックス化",
        latestDaysTitle: "最近の日数",
        latestDaysSubtitle: "最近の日数範囲にあるセマンティックメッセージをインデックス化",
        sinceEnabledTitle: "有効化以降",
        sinceEnabledSubtitle: "ローカルメモリが有効化された後に作成された内容をインデックス化",
      },
    },
    contentPolicy: {
      title: "インデックス対象",
      footer: "ユーザーとアシスタントのメッセージは既定でインデックス化されます。機密性の高いプロバイダー詳細は明示的に有効化しない限りオフです。",
      userMessagesTitle: "ユーザーメッセージ",
      userMessagesSubtitle: "あなたが書いたプロンプトと返信を含めます",
      assistantMessagesTitle: "アシスタントメッセージ",
      assistantMessagesSubtitle: "アシスタントの最終応答を含めます",
      reasoningTitle: "推論",
      reasoningSubtitle: "デーモンが対応している場合のみ推論サマリーを含めます",
      toolSummariesTitle: "ツール概要",
      toolSummariesSubtitle: "ツール活動のサニタイズ済み概要を含めます",
      toolOutputsTitle: "生のツール出力",
      toolOutputsSubtitle: "ローカルインデックスに生のツール出力テキストを含める意図がない限り無効のままにしてください",
    },
    hints: {
      title: "メモリヒント生成",
      footer:
        "ライトメモリ検索用の要約シャードをどのように生成するかを設定します。",
      backend: {
        title: "要約バックエンド",
        promptTitle: "要約バックエンド",
        promptBody:
          "実行ランのバックエンドIDを入力してください（例: claude, codex）。",
      },
      model: {
        title: "要約モデル",
        promptTitle: "要約モデル",
        promptBody: "バックエンドへ渡すモデルIDを入力してください。",
      },
      permissions: {
        triggerTitle: "要約権限",
        options: {
          noToolsTitle: "ツールなし（おすすめ）",
          noToolsSubtitle: "テキストのみ要約",
          readOnlyTitle: "読み取り専用",
          readOnlySubtitle: "対応している場合は、変更しないツールを許可",
        },
      },
    },
    embeddings: {
      modelTitle: "埋め込みモデル",
      promptBody: "ローカルの transformers モデル ID を入力してください。",
      modelPlaceholder: "Xenova/all-MiniLM-L6-v2",
      ...memoryEmbeddingsTranslationExtension.embeddings,
    },
  },

  subAgentGuidance: {
    ruleEditor: {
      header: {
        newRule: "新しいルール",
        editRule: "ルールを編集",
      },
      enabled: {
        title: "有効",
      },
      enabledState: {
        enabled: "有効",
        disabled: "無効",
      },
      common: {
        noPreference: "指定なし",
      },
      titleField: {
        label: "タイトル（任意）",
        placeholder: "例: UI作業",
      },
      descriptionField: {
        label: "いつエージェントが委任すべきですか？",
        placeholder: "いつ/どのように委任するかを記入…",
      },
      backendPicker: {
        title: "対象バックエンド（任意）",
        searchPlaceholder: "バックエンドを検索",
        noPreference: {
          subtitle: "バックエンドはエージェントに任せます。",
        },
      },
      modelPicker: {
        title: "対象モデル（任意）",
        searchPlaceholder: "モデルを検索",
        noPreference: {
          subtitle: "既定のモデルはバックエンドに任せます。",
        },
      },
      intent: {
        title: "推奨インテント（任意）",
        noPreference: {
          subtitle: "インテントはエージェントに任せます。",
        },
        options: {
          review: {
            title: "レビュー",
            subtitle: "コードレビュー / 所見。",
          },
          plan: {
            title: "プラン",
            subtitle: "計画 / アーキテクチャ。",
          },
          delegate: {
            title: "委任",
            subtitle: "委任 / 実行。",
          },
        },
      },
      exampleToolCalls: {
        label: "ツール呼び出し例（任意、1行に1つ）",
        placeholder: "例: execution.run.start …",
      },
    },
        settings: {
      groupTitle: "サブエージェント",
      disabled: {
        footer:
          "Execution Runs が無効です。設定 → 機能 で Execution Runs を有効にして、委任ガイダンスを利用してください。",
        enableExecutionRuns: {
          title: "Execution Runs を有効化",
          subtitle: "機能設定を開く",
        },
      },
      footer:
        "ルールはシステムプロンプトに追加され、メインエージェントがサブエージェント実行の好み（いつ・どのように）を把握できるようにします。",
      overview: {
        groupTitle: "概要",
        footer:
          "このページではサブエージェント向けガイダンスを設定し、関連するプロバイダー、バックエンド、セッション設定へ移動できます。",
        explainerTitle: "このページで制御する内容",
        explainerSubtitle:
          "サブエージェント向けの委任ガイダンスと、プロバイダー固有のサブエージェント設定へのリンクです。",
        happierStatusTitle: "サブエージェント",
        happierStatusEnabledSubtitle:
          "有効です。対応セッションからサブエージェントを起動できます。",
        happierStatusDisabledSubtitle:
          "無効です。機能設定を開いてサブエージェントを有効にしてください。",
      },
      related: {
        groupTitle: "関連設定",
        footer:
          "サブエージェントの起動と制御は、セッション動作、プロバイダー、設定済みバックエンドにも依存します。",
        sessionTitle: "セッション動作",
        sessionSubtitle:
          "メッセージ送信、忙しいときの誘導、リプレイ/再開の動作。",
        providersTitle: "プロバイダー",
        providersSubtitle:
          "プロバイダー固有の認証、ランタイム、エージェント設定。",
        backendsTitle: "ACP カタログ",
        backendsSubtitle: "設定済みバックエンドとカスタム起動先。",
      },
      enableInjection: {
        title: "ガイダンス注入を有効化",
      },
      characterBudget: {
        title: "文字数上限",
        subtitle: ({ value }: { value: string }) => `${value} 文字`,
        promptTitle: "文字数上限",
        promptBody: "システムプロンプトに追加する最大文字数。",
      },
      rules: {
        groupTitle: "ガイダンスルール",
        footerEnabled:
          "ルールをタップして編集します。エージェントは委任のヒントとして使用します。",
        footerDisabled: "注入を有効にしてルールを有効化します。",
        emptyTitle: "ルールはまだありません",
        emptySubtitle: "委任のためのルールを追加します。",
        addRuleTitle: "ルールを追加",
        addRuleSubtitle: "新しいガイダンスルールを作成",
        untitled: "無題のルール",
        descriptionFallback: "委任する条件を記入してください。",
        tapToEdit: "タップして編集",
        meta: {
          target: ({ value }: { value: string }) => `対象: ${value}`,
          model: ({ value }: { value: string }) => `モデル: ${value}`,
          intent: ({ value }: { value: string }) => `インテント: ${value}`,
        },
      },
      preview: {
        title: "プレビュー",
        footer:
          "これはシステムプロンプトに追加される（切り詰められた）テキストです。",
        systemPromptLabel: "システムプロンプト（追加）",
      },
      providers: {
        claude: {
          title: "Claude のチームエージェント",
          footer: "プロバイダー固有のサブエージェント動作は、プロバイダー設定画面で管理されます。",
          openTitle: "Claude のサブエージェントオプション",
          openSubtitle: "Agent Teams など、Claude 固有のサブエージェント動作を管理します。",
        },
      },
    },
  },

  settings: {
    title: "設定",
    overview: '概要',

    // Main settings hub category groups
    profileAndAccount: 'プロフィールとアカウント',
    aiAndAgents: 'AI とエージェント',
    sessionsBehavior: 'セッションと動作',
    general: '一般',
    filesAndSourceControl: 'ファイルとソース管理',
    system: 'システム',

    // Renamed / promoted items
    sessions: 'セッション',
    transcript: 'トランスクリプト',
    transcriptSubtitle: '思考、ツール表示、コード表示',
    permissions: '権限',
    permissionsSubtitle: '権限モードと承認の動作',
    filesSourceControl: 'ファイルとソース管理',
    filesSourceControlSubtitle: 'エディタ、差分、ソース管理連携',
    workspaces: 'ワークスペース',
    workspacesSubtitle: 'リンク済みワークスペース、場所、チェックアウトを管理',

    connectedAccounts: "接続済みアカウント",
    connectAccount: "アカウントを接続",
    github: "GitHub",
    machines: "マシン",
    features: "機能",
    social: "ソーシャル",
    account: "アカウント",
    accountSubtitle: "アカウントの詳細を管理",
    addYourPhone: "スマホを追加",
    addYourPhoneSubtitle: "スマホでサインインするためのQRコードを表示します",
    addMachine: "マシンを追加",
    machineSetupCurrentMachineTitle: "このコンピューター",
    machineSetupCurrentMachineSubtitle: "このデバイスに Happier を直接セットアップします",
    machineSetupAdoptExistingTitle: "既存のインストールを使用",
    machineSetupAdoptExistingSubtitle: "このコンピューターの既存のデーモン/サービス設定を使います",
    machineSetupAdoptExistingProgressTitle: "既存のインストールを確認しています",
    machineSetupAdoptExistingNotReady: "使用可能なインストールが見つかりませんでした。このコンピューターのセットアップを開始してください。",
    machineSetupSshMachineTitle: "SSH 経由のリモートマシン",
    machineSetupSshMachineSubtitle: "SSH で開発用ボックス、VM、またはサーバーに接続します",
    machineSetupStagesTitle: "手順",
    machineSetupStageConnect: "接続してアクセスを検証",
    machineSetupStageInstall: "Happier をインストールしてマシンをペアリング",
    machineSetupStageFinish: "内蔵ターミナルでセットアップを完了",
    machineSetupComingSoon: "マシンのセットアップは近日対応予定です。",
    machineSetupTaskWaitingForInput: "入力待ち",
    machineSetupRemoteSshTargetLabel: "SSH 接続先",
    machineSetupRemoteSshAgentAuthLabel: "SSH エージェントを使う",
    machineSetupRemoteSshKeyFileAuthLabel: "秘密鍵ファイルを使う",
    machineSetupRemoteSshIdentityFileLabel: "秘密鍵ファイルのパス",
    machineSetupRemoteRelayRuntimeLabel: "リモートマシンにも Relay ランタイムをインストールする",
    machineSetupRemoteRelayRuntimeTitle: "リモート Relay ランタイム",
    machineSetupRemoteRelayRuntimeReadyTitle: "リモートマシンで利用可能",
    machineSetupRemoteRelayRuntimeReadySubtitle: "SSH セットアップ中に Relay ランタイムをインストールしました。次のネットワーク設定では、そのマシンのリモート Relay URL を使ってください。",
    machineSetupRemoteRelayRuntimeUrlTitle: "リモート Relay URL",
    machineSetupRemoteRelayKeepCurrentTitle: "現在の Relay を維持",
    machineSetupRemoteRelayKeepCurrentSubtitle: "切り替えずにこの Relay URL を保存します。",
    machineSetupRemoteRelaySwitchTitle: "この Relay に切り替える",
    machineSetupRemoteRelaySwitchSubtitle: "今すぐ切り替えて、新しい Relay でセットアップを続行します。",
    machineSetupRemoteRelaySwitchConfirmTitle: "Relay を切り替えますか？",
    machineSetupRemoteRelaySwitchConfirmBody: ({ relayUrl }: { relayUrl: string }) =>
      `Happier を ${relayUrl} に切り替えてセットアップを続行しますか？`,
    machineSetupRemotePromptTrustAction: "ホストキーを信頼する",
    machineSetupRemotePromptReplaceAction: "保存済みキーを置き換える",
    machineSetupRemotePromptApproveAction: "ペアリングを承認",
    localRelayRuntime: {
      title: 'ローカル Relay ランタイム',
      statusTitle: 'ステータス',
      statusChecking: 'ローカル Relay ランタイムを確認しています',
      statusNotInstalled: 'このコンピューターにはまだインストールされていません',
      statusStopped: 'インストール済みですが、現在は実行されていません',
      statusRunningHealthy: '正常に実行・応答しています',
      statusRunningNeedsAttention: '実行中ですが、ヘルスチェックで注意が必要です',
      versionTitle: 'インストール済みバージョン',
      relayUrlTitle: 'ローカル Relay URL',
      installOrUpdateAction: 'Relay ランタイムをインストールまたは更新',
      startAction: 'Relay ランタイムを開始',
      stopAction: 'Relay ランタイムを停止',
      refreshAction: 'Relay の状態を更新',
      footer: '他のデバイスを接続する前に、このコンピューターで動作するセルフホスト Relay を管理します。',
      progressTitle: 'ローカル Relay ランタイムを更新しています',
      progressStepInspect: 'ローカル Relay ランタイムを確認',
      progressStepHealth: 'Relay のヘルスを確認',
      progressStepInstall: 'Relay ランタイムをインストール',
      progressStepStart: 'Relay ランタイムを開始',
      progressStepStop: 'Relay ランタイムを停止',
    },
localTailscale: {
      title: 'Tailscale によるプライベートアクセス',
      statusTitle: 'ステータス',
      statusUnavailable: '先にローカル Relay ランタイムを起動してください',
      statusIdle: 'まだ有効化されていません',
      statusWorking: '安全なプライベートアクセスを設定しています',
      statusReady: '他の tailnet デバイスから使用できます',
      statusInstallRequired: '続行するには Tailscale をインストールしてください',
      statusLoginRequired: '続行するには Tailscale にサインインしてください',
      statusNeedsApproval: 'Tailscale の承認を待っています',
      shareableUrlTitle: '共有可能なプライベート URL',
      approvalTitle: '承認が必要です',
      approvalSubtitle: 'Tailscale の承認フローを完了してから、ここに戻ってください。',
      installTitle: 'インストールが必要です',
      installSubtitle: 'Tailscale をインストールしてから、ここに戻ってください。',
      loginTitle: 'サインインが必要です',
      loginSubtitle: 'Tailscale のサインインを完了してから、ここに戻ってください。',
      enableAction: 'Tailscale でプライベートアクセスを有効化',
      refreshAction: 'プライベートアクセスを再確認',
      openApprovalAction: 'Tailscale の承認を開く',
      openInstallAction: 'Tailscale のダウンロードを開く',
      openLoginAction: 'Tailscale のサインインを開く',
      footer: 'これによりアクセスは tailnet 内に限定されます。スマホや別のコンピューターも同じ tailnet に参加している必要があります。',
      progressTitle: 'Tailscale の安全なアクセスを設定しています',
      progressStepDetect: 'Tailscale の利用可否を確認',
      progressStepInstall: 'Tailscale をインストール',
      progressStepLogin: 'Tailscale にサインイン',
      progressStepServeEnable: 'Relay のプライベートアクセスを有効化',
      progressStepVerifyUrl: '共有可能 URL を確認',
    },
    systemTaskStepPrepare: "タスクを準備",
    systemTaskStepInstallRuntime: "ランタイムをインストール",
    systemTaskStepFinish: "セットアップを完了",
    systemTaskCurrentStepLabel: "現在の手順",
    systemTaskLatestUpdateLabel: "最新の更新",
    systemTaskBridgeUnavailable: "このビルドではシステムタスクをまだ利用できません。",
    systemTaskStartFailed: "システムタスクを開始できませんでした。",
    appearance: "外観",
    appearanceSubtitle: "アプリの見た目をカスタマイズ",
    voiceAssistant: "音声アシスタント",
    voiceAssistantSubtitle: "音声操作の設定",
    memorySearch: "ローカルメモリ検索",
    memorySearchSubtitle: "過去の会話を検索（端末内）",
    notifications: "通知",
    notificationsSubtitle: "プッシュ通知の設定",
    attachments: "添付ファイル",
    attachmentsSubtitle: "ファイルアップロードの設定",
    sourceControl: "バージョン管理",
    sourceControlSubtitle: "コミット戦略とバックエンド挙動",
    automations: "自動化",
    automationsSubtitle: "スケジュール済みセッションと定期実行を管理",
    executionRunsSubtitle: "複数マシンでの実行",
    connectedServices: "接続済みサービス",
    connectedServicesSubtitle: "Claude/Codex のサブスクリプションと OAuth プロファイル",
    featuresTitle: "機能",
    featuresSubtitle: "アプリ機能の有効/無効を切り替え",
    pets: "ペット",
    petsSubtitle: "Blink とこのデバイスのペットコンパニオンを選択",
    developer: "開発者",
    developerTools: "開発者ツール",
    about: "このアプリについて",
    actionsSettingsAboutSubtitle:
      "アクションをグローバルに、サーフェス（UI/音声/MCP）別、配置（UI 内の表示場所）別に有効/無効にできます。無効化されたアクションは実行時に安全側（フェイルクローズ）でブロックされます。",
    aboutFooter:
      "Happier CoderはCodexとClaude Codeのモバイルクライアントです。デフォルトでエンドツーエンド暗号化され、他のデバイスでもアカウントを復元できます。Anthropicとは提携していません。",
    whatsNew: "新機能",
    whatsNewSubtitle: "最新のアップデートと改善を確認",
    reportIssue: "問題を報告",
    privacyPolicy: "プライバシーポリシー",
    termsOfService: "利用規約",
    rateUs: "Happier を評価する",
    rateUsSubtitle: "アプリを気に入っていただけたら、短い評価で応援してください",
    eula: "使用許諾契約",
    supportUs: "開発を支援",
    supportUsSubtitlePro: "ご支援ありがとうございます！",
    supportUsSubtitle: "プロジェクト開発を支援",
    scanQrCodeToAuthenticate: "QRコードをスキャンしてターミナルを接続",
    githubConnected: ({ login }: { login: string }) => `@${login}として接続中`,
    connectGithubAccount: "GitHubアカウントを接続",
    claudeAuthSuccess: "Claudeへの接続に成功しました",
    exchangingTokens: "トークンを交換中...",
    usage: "使用状況",
    usageSubtitle: "API使用量とコストを確認",
    profiles: "プロファイル",
    profilesSubtitle: "セッション用の環境変数プロファイルを管理",
    secrets: "シークレット",
    secretsSubtitle: "保存したシークレットを管理（入力後は再表示されません）",
    terminal: "ターミナル",
    session: "セッション",
    sessionSubtitleTmuxEnabled: "Tmux 有効",
    sessionSubtitleMessageSendingAndTmux: "メッセージ送信と tmux",
    actionsSubtitle: "各アクションをアプリ、音声、統合のどこに表示するかを選択します。",
    prompts: "プロンプトとスキル",
    promptsSubtitle: "プロンプトライブラリ、テンプレート、スタック",
    servers: "Relay",
    serversSubtitle: "保存済み Relay、グループ、既定値",
			    systemStatus: "システム状態",
			    systemStatusSubtitle: "Relay、アカウント、マシン、デーモン",
		    mcpServers: "MCP サーバー",
		    mcpServersSubtitle: "MCP サーバーとバインディングを管理します",
		    mcpServersComingSoon: "MCP サーバー設定は近日対応予定です。",
		    mcpServersStrictMode: "厳格モード",
		    mcpServersStrictModeSubtitle: "MCP サーバー設定が無効な場合はフェイルクローズします。",
		    mcpServersCatalogTitle: "カタログ",
		    mcpServersUnnamed: "無題のサーバー",
		    mcpServersEmptyTitle: "MCP サーバーはまだありません",
		    mcpServersEmptySubtitle: "セッションで使うには MCP サーバーを追加してください。",
		    mcpServersAddServer: "サーバーを追加",
		    mcpServersAddServerSubtitle: "新しい MCP サーバー項目を作成します",
		    mcpServersEditorTitle: "MCP サーバー",
		    mcpServersPickSecretTitle: "シークレットを選択",
		    mcpServersPickSecretNoneSubtitle: "シークレットが選択されていません",
		    mcpServersEditorBasics: "基本",
		    mcpServersEditorStdio: "標準入出力",
		    mcpServersEditorRemote: "リモート",
		    mcpServersEditorBindings: "バインディング",
		    mcpServersFieldName: "名前",
		    mcpServersFieldTitle: "タイトル",
		    mcpServersFieldTitlePlaceholder: "表示タイトル（任意）",
		    mcpServersFieldTransport: "トランスポート",
		    mcpServersFieldCommand: "コマンド",
		    mcpServersFieldArgs: "引数",
		    mcpServersFieldUrl: "URL",
		    mcpServersBindingTitle: "バインディング",
		    mcpServersBindingEnabled: "有効",
		    mcpServersBindingEnabledSubtitle: "このバインディングをオン/オフします",
		    mcpServersBindingTarget: "対象",
		    mcpServersBindingTargetSubtitle: "このサーバーを利用できる場所",
		    mcpServersBindingMachine: "マシン",
		    mcpServersBindingMachineSubtitle: "マシンを選択",
		    mcpServersBindingDeleteSubtitle: "このバインディングを削除します",
		    mcpServersBindingTargetAllMachines: "すべてのマシン",
		    mcpServersBindingTargetMachine: ({ machine }: { machine: string }) => `マシン: ${machine}`,
		    mcpServersBindingTargetWorkspace: ({ machine, path }: { machine: string; path: string }) =>
		      `ワークスペース: ${machine} • ${path}`,
		    mcpServersBindingTargetAllMachinesSubtitle: "すべてのマシンで有効化",
		    mcpServersBindingTargetMachineTitle: "マシン",
		    mcpServersBindingTargetMachineSubtitle: "1 台のマシンで有効化",
		    mcpServersBindingTargetWorkspaceTitle: "ワークスペース",
		    mcpServersBindingTargetWorkspaceSubtitle: "特定のワークスペースパスでのみ有効化",
		    mcpServersValidationFailed: "MCP サーバー設定が無効です。",
		    mcpServersServerNotFound: "サーバーが見つかりません。",
		    mcpServersBindingsEmptyTitle: "バインディングはまだありません",
		    mcpServersBindingsEmptySubtitle: "このサーバーを使うにはバインディングを追加してください。",
		    mcpServersAddBinding: "バインディングを追加",
		    mcpServersAddBindingSubtitle: "このサーバーをマシンまたはワークスペースで有効化します",
		    mcpServersSaveDisabledSubtitle: "保存する変更がありません。",
			    mcpServersDeleteTitle: "MCP サーバーを削除しますか？",
			    mcpServersDeleteConfirm: ({ name }: { name: string }) => `「${name}」を削除しますか？`,
			    mcpServersDeleteSubtitle: "このサーバーをカタログから削除します",
			    mcpServersNoMachineSelected: "マシンが選択されていません",
			    mcpServersDetectedTitle: "プロバイダー設定から検出",
			    mcpServersDetectedMachineTitle: "マシン",
			    mcpServersDetectedRefreshTitle: "検出済みサーバーを更新",
			    mcpServersDetectedRefreshSubtitle: "このマシンのプロバイダー設定ファイルをスキャンします",
			    mcpServersDetectedWarningsTitle: "検出警告",
			    mcpServersDetectedEmptyTitle: "検出された MCP サーバーはありません",
			    mcpServersDetectedEmptySubtitle: "更新して Claude/Codex/OpenCode の設定をスキャンしてください。",
			    mcpServersImportTitle: "MCP サーバーをインポートしますか？",
			    mcpServersImportConfirm: ({ provider, name }: { provider: string; name: string }) =>
			      `${provider} から「${name}」をインポートしますか？`,
			    mcpServersImportAction: "インポート",
			    mcpServersBindingSummaryAllMachines: "すべてのマシン",
			    mcpServersBindingSummaryMachines: ({ count }: { count: number }) =>
			      `${count} machine${count === 1 ? "" : "s"}`,
			    mcpServersBindingSummaryWorkspaces: ({ count }: { count: number }) =>
			      `${count} workspace${count === 1 ? "" : "s"}`,
			    mcpServersBindingSummaryNone: "未バインド",
			    mcpServersPickWorkspaceTitle: "ワークスペースのルートを選択",
			    mcpServersBindingWorkspaceRootTitle: "ワークスペースルート",
			    mcpServersBindingOverridesTitle: "上書き",
			    mcpServersBindingOverridesNone: "上書きなし",
			    mcpServersBindingOverridesCount: ({ count }: { count: number }) =>
			      `${count} 件の上書き`,
			    mcpServersEditorEnv: "環境",
			    mcpServersEnvAdd: "環境変数を追加",
			    mcpServersEnvAddSubtitle: "このサーバーの環境変数を設定します",
			    mcpServersEnvEmptyTitle: "環境変数がありません",
			    mcpServersEnvEmptySubtitle: "環境変数を追加するか、保存済みシークレットを使用してください。",
			    mcpServersEditorHeaders: "ヘッダー",
			    mcpServersHeadersAdd: "ヘッダーを追加",
			    mcpServersHeadersAddSubtitle: "このサーバーの HTTP/SSE ヘッダーを設定します",
			    mcpServersHeadersEmptyTitle: "ヘッダーがありません",
			    mcpServersHeadersEmptySubtitle: "サーバーで認証が必要な場合はヘッダーを追加してください。",
			    mcpServersEnvEditorTitle: "環境変数を編集",
			    mcpServersHeadersEditorTitle: "ヘッダーを編集",
			    mcpServersEnvKeyLabel: "環境変数名",
			    mcpServersEnvKeyPlaceholder: "API_KEY",
		    mcpServersHeaderKeyLabel: "ヘッダー名",
			    mcpServersHeaderKeyPlaceholder: "Authorization",
			    mcpServersValueSourceTitle: "値の取得元",
			    mcpServersArgsPlaceholder: "--flag\nvalue",
			    mcpServersValueSourceLiteral: "リテラル",
			    mcpServersValueSourceLiteralSubtitle: "値を保存します（${VAR} テンプレートに対応）",
			    mcpServersValueSourceSavedSecret: "保存済みシークレット",
			    mcpServersValueSourceSavedSecretNamed: ({ name }: { name: string }) => `保存済みシークレット: ${name}`,
			    mcpServersValueSourceSavedSecretSubtitle: "保存済みシークレットを参照します",
			    mcpServersValueLiteralLabel: "値",
			    mcpServersValueLiteralPlaceholder: "値 または ${ENV_VAR}",
			    mcpServersValueSecretLabel: "保存済みシークレット",
			    mcpServersValueSecretSelect: "シークレットを選択",
			    mcpServersValueSecretSelectSubtitle: "保存済みシークレットを選択します",
			    mcpServersKeyInvalid: "キーが無効です。",
			    mcpServersKeyAlreadyExists: "そのキーは既に存在します。",
			    mcpServersOverridesStdioTitle: "Stdio の上書き",
			    mcpServersOverridesCommandTitle: "コマンドの上書き",
			    mcpServersOverridesCommandSubtitle: "このバインディングには別のコマンドを使います",
			    mcpServersOverridesArgsTitle: "引数の上書き",
			    mcpServersOverridesArgsSubtitle: "このバインディングには別の引数を使います（空欄 = 引数なし）",
			    mcpServersOverridesRemoteTitle: "リモートの上書き",
			    mcpServersOverridesUrlTitle: "URL の上書き",
			    mcpServersOverridesUrlSubtitle: "このバインディングには別の URL を使います",
			    mcpServersOverridesEnvPatchTitle: "環境変数パッチ",
			    mcpServersOverridesEnvPatchEmptyTitle: "環境変数の上書きはありません",
			    mcpServersOverridesEnvPatchEmptySubtitle: "環境変数の上書きまたは削除を追加します。",
			    mcpServersOverridesHeadersPatchTitle: "ヘッダーパッチ",
			    mcpServersOverridesHeadersPatchEmptyTitle: "ヘッダーの上書きはありません",
			    mcpServersOverridesHeadersPatchEmptySubtitle: "ヘッダーの上書きまたは削除を追加します。",
			    mcpServersOverridesDeleteValue: "このキーをこのバインディングから削除します",
			    mcpServersOverridesEnvPatchAddTitle: "環境変数の上書きを追加",
			    mcpServersOverridesEnvPatchAddSubtitle: "このバインディングの環境変数を設定または上書きします",
			    mcpServersOverridesEnvPatchDeleteTitle: "環境変数キーを削除",
			    mcpServersOverridesEnvPatchDeleteSubtitle: "このバインディングの環境変数を削除します",
			    mcpServersOverridesHeadersPatchAddTitle: "ヘッダーの上書きを追加",
			    mcpServersOverridesHeadersPatchAddSubtitle: "このバインディングのヘッダーを設定または上書きします",
			    mcpServersOverridesHeadersPatchDeleteTitle: "ヘッダーキーを削除",
			    mcpServersOverridesHeadersPatchDeleteSubtitle: "このバインディングのヘッダーを削除します",
			    mcpServersOverridesDeleteEnvTitle: "環境変数キーを削除",
			    mcpServersOverridesDeleteEnvPrompt: "このバインディングから削除する環境変数名を入力してください。",
			    mcpServersOverridesDeleteHeaderTitle: "ヘッダーキーを削除",
			    mcpServersOverridesDeleteHeaderPrompt: "このバインディングから削除するヘッダー名を入力してください。",
			    mcpServersOverridesCommandRequired: "コマンドの上書きは有効ですが、空です。",
			    mcpServersOverridesUrlRequired: "URL の上書きは有効ですが、空です。",
			    mcpServersTestTitle: "テスト",
			    mcpServersTestFooter: "選択したマシンで実行されます。結果にシークレットは表示されません。",
			    mcpServersTestMachineTitle: "マシンでテスト",
			    mcpServersTestBindingTitle: "バインディングを使用",
			    mcpServersTestNoBinding: "バインディングなし",
			    mcpServersTestNoBindingSubtitle: "バインディングの上書きなしでテストします",
			    mcpServersTestDirectoryTitle: "作業ディレクトリ",
			    mcpServersTestDirectorySubtitle: "タップしてディレクトリを設定します",
			    mcpServersTestDirectoryPrompt: "テスト用の作業ディレクトリを入力してください。",
			    mcpServersTestRunTitle: "サーバーをテスト",
			    mcpServersTestRunSubtitle: "接続してツールを一覧表示します",
			    mcpServersTestResultOkTitle: "テスト成功",
			    mcpServersTestResultOkSubtitle: ({
			      toolCount,
			      durationMs,
			    }: {
			      toolCount: number;
			      durationMs: number;
			    }) => `${toolCount} 個のツール · ${durationMs}ms`,
			    mcpServersTestResultErrorTitle: "テスト失敗",
        ...mcpServersUxTranslationExtension,
        ...acpCatalogTranslationExtension.settings,

			    // Dynamic settings messages
			    accountConnected: ({ service }: { service: string }) =>
			      `${service}アカウントが接続されました`,
    machineStatus: ({
      name,
      status,
    }: {
      name: string;
      status: "online" | "offline";
    }) => `${name}は${status === "online" ? "オンライン" : "オフライン"}です`,
		  featureToggled: ({
		      feature,
		      enabled,
		    }: {
		      feature: string;
		      enabled: boolean;
		    }) => `${feature}を${enabled ? "有効" : "無効"}にしました`,

    remoteHostsTitle: "リモートホスト",
    remoteHostsDesktopOnlyTitle: "リモートホストはデスクトップのみで利用できます",
    remoteHostsDesktopOnlySubtitle: "デスクトップで保存済みSSHホストを管理します。",
    remoteHostsManagementDisabledTitle: "リモートホスト管理は無効です",
    remoteHostsManagementDisabledSubtitle: "このビルドではリモートホストを管理できません。",
    remoteHostsEmptyTitle: "リモートホストがありません",
    remoteHostsEmptySubtitle: "リモートホストを追加して、セットアップでSSH資格情報を再利用します。",
    remoteHostsAddHost: "リモートホストを追加",
    remoteHostsAddHostTitle: "リモートホストを追加",
    remoteHostsEditHostTitle: "リモートホストを編集",
    remoteHostsHostGroupTitle: "ホスト",
    remoteHostsSshGroupTitle: "SSH",
    remoteHostsSecretMaterialGroupTitle: "シークレット",
    remoteHostsSavePasswordLabel: "パスワードを保存",
    remoteHostsPasswordSavedTitle: "パスワードは保存されています",
    remoteHostsPasswordSavedSubtitle: "変更しない場合は空欄のままにしてください。",
    remoteHostsStorePrivateKeyLabel: "秘密鍵を保存（暗号化）",
    remoteHostsPrivateKeyLabel: "秘密鍵",
    remoteHostsPrivateKeySavedHint: "秘密鍵はすでに保存されています。変更しない場合は空欄のままにしてください。",
    remoteHostsSecretMaterialDisabledTitle: "シークレットの保存は無効です",
    remoteHostsSecretMaterialDisabledSubtitle: "このビルドではパスワードや秘密鍵を保存できません。",
    remoteHostsSetupAsMachineTitle: "Happier マシンとして設定",
    remoteHostsSetupAsMachineFailed: "このホストを Happier マシンとして設定できませんでした。",
    remoteHostsConnectFromThisDeviceTitle: "このデバイスから接続",
    remoteHostsConnectFromThisDeviceSubtitle: "このデバイスのみ。このアプリセッション用のローカル SSH トンネルを開きます。",
    remoteHostsConnectFromThisDeviceFailed: "ローカル SSH トンネルを開けませんでした。",
    remoteHostsNativeSshTunnelRequiresEngine: "このデバイスから開始するには、ネイティブ SSH トンネルにネイティブ SSH エンジンのビルドが必要です。",
    remoteHostsSshTunnelGroupTitle: "このデバイスからリモートホストに到達",
    remoteHostsSshTunnelActiveTitle: ({ host }: { host: string }) => `${host} の SSH トンネルが有効です`,
    remoteHostsSshTunnelActiveSubtitle: ({ url }: { url: string }) => `このデバイスのみ。ローカルエンドポイント: ${url}`,
    remoteHostsSshTunnelStopTitle: "ローカル SSH トンネルを停止",
    remoteHostsUseAsRelayHostTitle: "Relay ホストとして使う",
    remoteHostsUseAsRelayHostSubtitle: "この SSH ホストで Relay アクセスを設定します。",
    remoteHostsConfigureAccessTitle: "アクセスを設定",
    remoteHostsConfigureAccessSubtitle: "このリモートホストへの到達方法を選択します。",
    remoteHostsOpenDetailsTitle: "ホストの詳細",
    remoteHostsRelayAccessGroupTitle: "リモートアクセス",
    remoteHostsRelayAccessActiveTitle: ({ host }: { host: string }) => `${host} のアクセスを設定中`,
    remoteHostsRelayAccessActiveSubtitle: "Relay アクセスコマンドは SSH 経由でリモートホスト上で実行されます。SSH トンネルは作成しません。",
    remoteHostsMissingServerUrl: "リモートマシンを設定する前にサーバーを選択してください。",
    remoteHostsRelayAccessIdentityFileRequired: "このホストで Relay アクセスを使うにはローカル SSH ID ファイルが必要です。",
    remoteHostsTestConnectionTitle: "接続をテスト",
    remoteHostsInstallOrUpdateCliTitle: "CLI をインストール／更新",
    remoteHostsDaemonServiceInstallOrUpdateTitle: "デーモンサービスをインストール／更新",
    remoteHostsDaemonServiceStartTitle: "デーモンサービスを開始",
    remoteHostsDaemonServiceStopTitle: "デーモンサービスを停止",
    remoteHostsDaemonServiceRestartTitle: "デーモンサービスを再起動",
    remoteHostsRelayRuntimeStatusTitle: "リレーランタイムの状態",
    remoteHostsRelayRuntimeInstallOrUpdateTitle: "リレーランタイムをインストール／更新",
    remoteHostsRelayRuntimeStartTitle: "リレーランタイムを開始",
    remoteHostsRelayRuntimeStopTitle: "リレーランタイムを停止",
    remoteHostsRelayRuntimeRestartTitle: "リレーランタイムを再起動",
    remoteHostsPortLine: ({ port }: { port: number }) => `ポート: ${port}`,
    remoteHostsActiveTaskTitle: "システムタスク",
    remoteHostsHostTrustTitle: "SSHホストを信頼しますか？",
    remoteHostsReplaceHostKeyTitle: "SSHホストキーを置き換えますか？",
    remoteHostsReplaceHostKeyAction: "ホストキーを置き換える",
    remoteHostsHostKeyCurrentFingerprintLabel: "現在信頼しているフィンガープリント",
    remoteHostsHostKeyNewFingerprintLabel: "新しいフィンガープリント",
    remoteHostsPasswordRequiredTitle: "SSHパスワードが必要です",
    remoteHostsRememberHostKeyTitle: "この SSH ホストキーを記憶しますか？",
    remoteHostsRememberHostKeyAction: "信頼して記憶",
    remoteHostsTrustOnceAction: "今回だけ信頼",
    remoteHostsPrivateKeyPassphraseTitle: "SSH 秘密鍵のパスフレーズ",
    remoteHostsKeyboardInteractiveTitle: "SSH 認証",
    remoteHostsKeyboardInteractivePromptLabel: "SSH プロンプト",
    remoteHostsTrustedHostKeysTitle: "信頼済み SSH ホストキー",
    remoteHostsTrustedHostKeyRemoveTitle: "信頼済み SSH ホストキーを削除しますか？",
    remoteHostsTrustedHostKeysClearTitle: "信頼済み SSH ホストキーをクリア",
    remoteHostsConnectionSucceeded: "接続に成功しました。",
    remoteHostsConnectionFailed: "接続に失敗しました。",
    sshConfiguredHostPickerTitle: "候補の SSH ホスト",
    sshConfiguredHostPickerSubtitle: "ローカル SSH 設定または known_hosts から入力します。",
    sshConfiguredHostPickerRefreshingSubtitle: "候補を更新中です。最後の結果を表示しています。",
    sshConfiguredHostPickerSourceSshConfig: "SSH 設定",
    sshConfiguredHostPickerSourceKnownHosts: "known_hosts",
    sshConfiguredHostPickerUnsupportedTitle: "SSH 詳細を手動で入力",
    sshConfiguredHostPickerUnsupportedSubtitle: "ローカル SSH 検出はデスクトップアプリでのみ利用できます。",
    sshConfiguredHostPickerLoadingTitle: "SSH ホストを検索中…",
    sshConfiguredHostPickerLoadingSubtitle: "デスクトップブリッジ経由でローカル SSH 設定と known_hosts を確認しています。",
    sshConfiguredHostPickerEmptyTitle: "候補の SSH ホストはありません",
    sshConfiguredHostPickerEmptySubtitle: "SSH 詳細を手動で入力するか、SSH 設定を更新してから再読み込みしてください。",
    sshConfiguredHostPickerErrorTitle: "SSH 候補を読み込めませんでした",
    sshConfiguredHostPickerRefreshTitle: "SSH 候補を更新",
    sshConfiguredHostPickerRefreshingTitle: "SSH 候補を更新中",
    machineSetupStepResolveRelay: "既存のコンポーネントを確認中",
    machineSetupStepCheckAuth: "サインイン状態を確認中",
    machineSetupStepConfigureRelay: "Relay に接続中",
    machineSetupStepAuthRequest: "このコンピューターを承認",
    machineSetupStepAuthWait: "承認を待機中",
    machineSetupStepInstallService: "バックグラウンドサービスをインストール中",
    machineSetupStepStartService: "バックグラウンドサービスを起動中",
    machineSetupStepVerifyService: "バックグラウンドサービスを検証中",
    machineSetupRemoteSshTargetPlaceholder: "user@host",
    machineSetupRemoteSshUsernameLabel: "SSH ユーザー名",
    machineSetupRemoteSshUsernamePlaceholder: "ubuntu",
    machineSetupRemoteSshHostLabel: "SSH ホスト",
    machineSetupRemoteSshHostPlaceholder: "example.test",
    machineSetupRemoteSshPortLabel: "SSH ポート",
    machineSetupRemoteSshPortPlaceholder: "22",
    machineSetupRemoteSshAuthMethodLabel: "認証方法",
    machineSetupRemoteSshPasswordAuthLabel: "パスワードを使う",
    machineSetupRemoteSshPrivateKeyMaterialLabel: "秘密鍵を貼り付け",
    machineSetupRemoteSshPasswordLabel: "SSH パスワード",
    relayAccess: {
      title: 'Relay アクセス',
      footer: 'スマホがこの Relay に接続する方法を選択します。',
      statusTitle: 'ステータス',
      statusNotConfigured: '未設定',
      statusWorking: 'Relay アクセスを確認中',
      statusEnabled: '有効',
      statusDisabled: '無効',
      statusNeedsAuth: 'サインインが必要です',
      statusError: 'エラー',
      statusUnknown: '不明',
      shareableUrlTitle: '共有可能 URL',
      methodTitle: 'アクセス方法',
      saveAction: 'アクセス方法を保存',
      disableAction: 'Relay アクセスを無効化',
      refreshAction: 'アクセス状態を更新',
      progressStepInspect: '現在の設定を確認',
      progressStepCheck: 'アクセス状態を確認',
      progressStepPersist: 'アクセス設定を保存',
      progressStepApply: 'アクセス設定を適用',
      progressStepVerify: 'アクセス URL を検証',
      progressStepDisable: 'Relay アクセスを無効化',
      providers: {
        localOnly: {
          title: 'ローカルのみ',
          subtitle: 'このコンピュータだけが Relay に接続できます。',
        },
        lan: {
          title: 'LAN / カスタム URL',
          subtitle: '既存の URL（LAN IP またはトンネル）を使用します。',
        },
        tailscaleServe: {
          title: 'Tailscale Serve',
          subtitle: 'tailnet 用のプライベート URL（推奨）。',
        },
        tailscaleFunnel: {
          title: 'Tailscale Funnel',
          subtitle: 'Funnel によるパブリック URL。',
        },
        cloudflareNamed: {
          title: 'Cloudflare トンネル',
          subtitle: '名前付き Cloudflare トンネルによるパブリック URL。',
        },
      },
      fields: {
        urlLabel: 'Relay の URL',
        hostnameLabel: 'ホスト名',
        tokenLabel: 'トークン',
      },
      missingUrl: '続行するには Relay URL を入力してください。',
      missingHostname: '続行するにはホスト名を入力してください。',
      missingToken: '続行するにはトークンを入力してください。',
      webHandoffTitle: 'このコマンドを実行',
      webHandoffSubtitle: 'CLI で relay アクセスを設定し、ここに戻って更新してください。',
    },
    accessEndpoints: {
      status: {
        refreshing: 'アクセスチャネルを更新中',
      },
      scope: {
        availableToOtherDevices: '他のデバイスで利用可能',
        thisDeviceOnly: 'このデバイスのみ',
      },
      direction: {
        makeCurrentServerReachable: 'このサーバーを到達可能にする',
        reachRemoteServerFromThisDevice: 'このデバイスからリモートサーバーに接続',
        unknown: 'アクセスチャネル',
      },
      kind: {
        'relay-access-provider': 'Relay アクセス',
        'ssh-tunnel-desktop': 'デスクトップ SSH トンネル',
        'ssh-tunnel-native': 'ネイティブ SSH トンネル',
        'server-profile-url': 'サーバー URL',
        'peer-mediation': 'ピア仲介',
        'manual-url': '手動 URL',
      },
      recommendedUse: {
        'multi-device': '他のデバイスに最適',
        'native-this-device': 'このネイティブアプリで動作',
        'hosted-web': 'ホストされた Web から動作',
        'lan-only': 'LAN またはプライベートネットワークのみ',
        diagnostic: '確認が必要',
      },
      limitation: {
        'this-device-only': 'このデバイスのみ',
        'not-hosted-web-compatible': 'ホストされた Web では利用不可',
        'not-public-share-url': '公開共有 URL ではありません',
        'session-scoped': 'セッション限定',
        'authentication-failed': 'SSH 認証に失敗しました',
        'foreground-only': 'アプリをフォアグラウンドに保つ必要があります',
        'host-key-mismatch': 'SSH ホストキーが変更されました',
        'host-key-rejected': 'SSH ホストキーが拒否されました',
        'host-key-untrusted': 'SSH ホストキーはまだ信頼されていません',
        'platform-suspended': 'アプリの一時停止中は停止します',
        'loopback-bind-failed': 'ローカルトンネルポートをバインドできませんでした',
        'network-captive-portal': 'ネットワークが SSH 接続を傍受しました',
        'remote-service-unreachable': 'トンネル経由でリモートサービスに到達できません',
        'requires-auth': 'SSH 認証が必要',
        'requires-host-key-trust': 'ホストキーの信頼が必要',
      },
      remediation: {
        tailscale: {
          install: 'Tailscale をインストール',
          login: 'Tailscale にサインイン',
          serve: {
            enable: 'Tailscale Serve を有効化',
            approve: 'Tailscale Serve を承認',
          },
          funnel: {
            approve: 'Tailscale Funnel を承認',
          },
        },
        cloudflare: {
          configure: 'Cloudflare トンネルを設定',
        },
        serverProfile: {
          configureShareableUrl: '共有 URL を設定',
        },
        remoteHost: {
          add: 'リモートホストを追加',
          setup: 'リモートホストを設定',
        },
        sshTunnel: {
          start: 'SSH トンネルを開始',
          reuse: '既存の SSH トンネルを使用',
          stop: 'SSH トンネルを停止',
          authenticate: 'SSH トンネルを認証',
          trustHost: 'SSH ホストキーを信頼',
        },
      },
    },
    systemTaskOpenLogs: "ログを開く",
    systemTaskOpenLogsFailed: "ログフォルダを開けませんでした。",},

	  systemStatus: {
	    sections: {
	      application: "アプリケーション",
	      updates: "アップデート",
	      appHealth: "アプリ + 同期の状態",
	      currentServer: "現在の Relay",
      identity: "サインイン情報",
      configuredServers: "設定済み Relay",
      machinesActiveServer: "マシン（アクティブ Relay）",
      machinesOtherServer: ({ server }: { server: string }) => `マシン（${server}）`,
      actions: "アクション",
    },
    application: {
      appVersion: "アプリのバージョン",
      nativeVersion: "ネイティブ版",
      buildNumber: "ビルド番号",
      applicationId: "アプリケーション ID",
      updateChannel: "更新チャンネル",
      updateId: "現在の更新 ID",
      runtimeVersion: "ランタイムバージョン",
      updateCreatedAt: "現在の更新日時",
      launchSource: "起動元",
      launchSourceEmbedded: "組み込みネイティブバイナリ",
      launchSourceOta: "ダウンロード済み OTA 更新",
      launchSourceUnknown: "不明",
    },
    updates: {
      otaStatus: "OTA 状態",
      lastChecked: "最終確認",
      openStore: "ストアの更新を開く",
      available: "利用可能",
      checkNow: "今すぐ確認",
      checkNowSubtitle: "現在の更新チャンネルで新しい OTA を手動確認します。",
      applyNow: "今すぐ適用",
      disabled: "無効",
      applying: "アップデートを適用中",
      readyToApply: "適用準備完了",
      downloading: "ダウンロード中",
      downloadingProgress: ({ progress }: { progress: string }) => `ダウンロード中 (${progress})`,
      checking: "確認中",
      error: "エラー",
      upToDate: "最新です",
      unknown: "不明",
    },
    ui: {
      dataReady: "データ準備完了",
      realtime: "リアルタイム",
      socket: "ソケット",
      socketLastError: ({ error }: { error: string }) => `最後のエラー: ${error}`,
      lastSync: "最終同期",
    },
    server: {
      activeServer: "アクティブ Relay",
    },
    identity: {
      accountId: "アカウントID",
      username: "ユーザー名",
    },
    servers: {
      noneConfigured: "Relayが設定されていません",
      active: "アクティブ",
    },
    machines: {
      none: "マシンなし",
      status: ({ status }: { status: string }) => `状態: ${status}`,
    },
    machine: {
      unknownHost: "不明なマシン",
      online: "オンライン",
      offline: "オフライン",
      fetchDoctorSnapshot: {
        loading: "デーモンのRelay/アカウントを取得中…",
        invalid: "マシンから doctor スナップショットを取得できませんでした",
      },
      daemonAttributionUnknown: "デーモンのRelay/アカウント: 不明",
      daemonAttribution: ({ serverUrl, accountId }: { serverUrl: string; accountId: string }) =>
        `デーモン: ${serverUrl} • ${accountId}`,
      daemonAttributionAge: ({ age }: { age: string }) => `最終確認: ${age}`,
      cliVersionBullet: ({ version }: { version: string }) => ` • v${version}`,
    },
    mismatch: "不一致",
    time: {
      secondsAgo: ({ count }: { count: number }) => `${count}秒前`,
      minutesAgo: ({ count }: { count: number }) => `${count}分前`,
      hoursAgo: ({ count }: { count: number }) => `${count}時間前`,
      daysAgo: ({ count }: { count: number }) => `${count}日前`,
    },
    actions: {
      runDiagnosis: "診断を実行",
      runDiagnosisSubtitle: "Relay/アカウント/デーモンの不一致を検出",
      refreshMachineAttribution: "マシンのデーモン情報を更新",
      refreshMachineAttributionSubtitle: "オンラインのマシンからデーモンのRelay/アカウントを取得",
      copyJson: "System Status JSON をコピー",
      copyJsonSubtitle: "サポート向けに安全なスナップショットを共有",
    },
  },

  diagnosis: {
    title: "診断",
    sections: {
      overview: "概要",
      actions: "アクション",
      pasteDoctorJson: "CLI doctor JSON を貼り付け",
      machineRuns: "マシン実行",
      serverProbe: "サーバープローブ",
      findings: "検出結果",
    },
    overview: {
      activeServer: "アクティブ Relay",
      account: "アカウント",
      onlineMachines: "オンラインのマシン（アクティブサーバー）",
      cachedAttribution: ({ count }: { count: number }) => `キャッシュされた doctor スナップショット: ${count} 件`,
    },
    actions: {
      run: "診断を実行",
      runSubtitle: "サーバー、アカウント、マシン、デーモンのターゲットを確認",
      copyReport: "診断レポートをコピー",
      copyReportSubtitle: "サポート向けの安全なJSONレポートをコピー",
    },
    pasteDoctorJson: {
      footer: "ヒント: PCで happier doctor --json を実行して貼り付けてください。",
      placeholder: '{ "capturedAt": "...", ... }',
      parse: "貼り付けたJSONを検証",
      ok: "貼り付けた doctor JSON は有効に見えます。",
      helper: "任意: マシンに接続できない場合、doctor JSON を貼り付けて不一致を診断できます。",
      error: ({ error }: { error: string }) => `無効な doctor JSON: ${error}`,
    },
    machine: {
      invalidDoctorSnapshot: "マシンが無効な doctor スナップショットを返しました",
    },
    machineRuns: {
      none: "オンラインのマシンがありません",
      idle: "待機",
      loading: "実行中…",
      ready: "完了",
      error: "エラー",
    },
    serverProbe: {
      title: "サーバー診断",
      httpError: ({ status }: { status: string }) => `HTTP ${status}`,
    },
    findings: {
      notRun: "診断を実行して結果を表示",
      notRunSubtitle: "安全な（ログなしの）チェックを実行します。ログはバグ報告で診断を含めた場合のみ送信されます。",
      none: "問題は検出されませんでした",
      noneSubtitle: "問題が続く場合は、診断付きでバグ報告を送信してください。",
      code: ({ code }: { code: string }) => `コード: ${code}`,
      generic: {
        subtitle: ({ code }: { code: string }) => `${code} の詳細`,
        steps: {
          reportIssue: "バグ報告を送信し、この診断レポートを含めてください。",
        },
      },
      serverMismatch: {
        title: "サーバー不一致（UI vs デーモン）",
        subtitle: ({ ui, machine }: { ui: string; machine: string }) => `UI: ${ui} • デーモン: ${machine}`,
        steps: {
          chooseAccount: "使用するサーバー/アカウントを決めてください。",
          switchUiServer: "UI とデーモンを同じサーバーに揃えてください。",
          restartDaemon: "正しいサーバーを指定してデーモンを再起動し、再試行してください。",
        },
      },
      serverMismatchPasted: {
        title: "サーバー不一致（UI vs 貼り付け）",
        subtitle: ({ ui, pasted }: { ui: string; pasted: string }) => `UI: ${ui} • 貼り付け: ${pasted}`,
      },
      settingsMismatch: {
        title: "CLI設定と解決されたサーバーの不一致",
        subtitle: ({ settings, resolved }: { settings: string; resolved: string }) => `settings.json: ${settings} • resolved: ${resolved}`,
      },
      accountMismatch: {
        title: "アカウント不一致（UI vs デーモン）",
        subtitle: ({ ui, machine }: { ui: string; machine: string }) => `UI: ${ui} • デーモン: ${machine}`,
        steps: {
          signInSameAccount: "UI と CLI を同じサーバーの同じアカウントでサインインしてください。",
          cliReauth: "CLIでログアウトし、正しいサーバーで再認証してください。",
        },
      },
      machineMissingAccount: {
        title: "マシンにアカウント情報がありません",
      },
      noOnlineMachines: {
        title: "オンラインのマシンがありません",
        steps: {
          startDaemon: "デーモンを起動し、動作し続けることを確認してください。",
          checkNetwork: "ネットワークを確認して再試行してください。",
        },
      },
      serverDiagnosticsDisabled: {
        title: "サーバー診断が無効",
        steps: {
          ok: "サーバーで診断が無効になっている場合、これは正常です。",
        },
      },
      serverAuthError: {
        title: "サーバー認証エラー（401）",
      },
      serverUnreachable: {
        title: "サーバーに接続できません",
        steps: {
          checkServerUrl: "サーバーURLとネットワークを確認してください。",
          tryAgain: "少し待って再試行してください。",
        },
      },
      serverHttpError: {
        title: "サーバー診断のHTTPエラー",
        subtitle: ({ status }: { status: string }) => `サーバーが ${status} を返しました`,
      },
      activeServerNotInProfiles: {
        title: "アクティブサーバーが保存済みプロファイルにありません",
      },
      multipleServers: {
        title: "マシン間で複数サーバーが検出されました",
      },
    },
  },

  connectedServices: {
    fallbackName: "連携サービス",
    serviceNames: {
      claudeSubscription: "Claude サブスクリプション",
      openaiCodex: "OpenAI Codex（OpenAI）",
      openai: "OpenAI API キー",
      anthropic: "Anthropic API キー",
      gemini: "Google Gemini（Google）",
      github: "GitHub",

      bitbucket: "Bitbucket",},
    title: "接続済みサービス",
    authChip: {
      label: "認証",
      labelWithCount: ({ count }: { count: number }) => `認証: ${count}`,
      nativeLabel: "ネイティブ",
      connectedCountLabel: ({ count }: { count: number }) => `${count} 件接続済み`,
    },
    authSwitch: {
      switchFailed: 'このセッションの認証を切り替えられませんでした。',
      confirmAction: '認証を切り替える',
      errors: {
        groupGenerationConflict: '切り替えが完了する前にアカウントグループが変更されました。アカウント一覧を更新してもう一度お試しください。',
        providerStateSharingRequired: 'Provider state sharing must be enabled before this account can be used for the running session.',
        notGroupSelection: 'Choose an account group so Happier can switch away from an exhausted account automatically.',
        connectedServiceRequired: 'Choose a connected account before using this recovery action for the session.',
        profileActionRequired: 'The selected connected account needs attention before it can be used.',
        providerStateSharingUnavailable: 'このマシンでプロバイダー状態共有設定を確認できませんでした。デーモン接続を更新してもう一度お試しください。',
        profileDisconnected: '選択した接続済みアカウントは、使用前に再認証が必要です。',
        profileMissing: '選択した接続済みアカウントは利用できなくなりました。アカウント一覧を更新して別のアカウントを選択してください。',
        groupMissing: '選択したアカウントグループは利用できなくなりました。アカウント一覧を更新して別のグループを選択してください。',
        metadataUpdateFailed: 'セッションは新しい認証選択を保存できませんでした。セッションの同期完了後にもう一度お試しください。',
        restartFailed: '新しい認証選択でセッションを再起動できませんでした。セッションを停止してもう一度お試しください。',
        hotApplyFailed: '実行中のセッションが新しい認証選択を拒否しました。セッションを再起動してもう一度お試しください。',
        agentMismatch: 'この認証選択はセッションのバックエンドと一致しません。',
        sessionNotFound: 'このセッションは選択したマシンでは利用できなくなりました。',
        unsupportedService: 'このバックエンドは選択した接続済みサービスをサポートしていません。',
      },
      status: {
        liveApplied: '実行中のセッションで認証を切り替えました',
        credentialsRefreshed: '認証を更新しました',
        restarting: 'セッションを再起動中',
        appliesOnNextResume: '次回の再開時に適用',
        retry: 'Authentication switch needs retry',
        partialApplication: "認証の一部を切り替えました",
        partialApplicationServiceFailed: ({ service }: { service: string }) => `${service} の認証に失敗しました`,
        partialApplicationServiceNotApplied: ({ service }: { service: string }) => `${service} の認証は適用されませんでした`,
      },
      partialApply: {
        title: '認証は部分的に切り替わりました',
        body: '新しいアカウントは保存されましたが、実行中のこのセッションへの適用は完全には成功しませんでした。再試行するか、このセッションを以前のアカウントに戻してください。',
        retry: 'このセッションに再適用',
        revert: '以前のアカウントに戻す',
      },
    },
    errors: {
      credentialReferencedByGroup: 'この接続アカウントはアカウントグループで使用されています。切断すると、それらのグループから削除され、必要に応じてアクティブ設定も解除されます。',
      runtimeCooldown: ({ time }: { time: string }) => `This account is cooling down until ${time}.`,
      runtimeCooldownOverrideTitle: 'クールダウン中のアカウントに切り替えますか？',
      runtimeCooldownOverrideBody: ({ time }: { time: string }) =>
        `This account is cooling down until ${time}. Switch manually anyway?`,
      runtimeCooldownOverrideConfirm: 'それでも切り替える',
      unknownResetTime: '不明な時刻',
      generationConflict: 'このアカウントグループは操作完了前に変更されました。アカウント一覧を更新して再試行してください。',
      generationConflictWithGeneration: ({ generation }: { generation: number }) =>
        `This account group changed before the action completed. Refresh the account list and try again. Current generation: ${generation}.`,
      generationRequired: 'この操作には新しいアカウントグループのバージョンが必要です。アカウント一覧を更新して再試行してください。',
      groupNotFound: 'このアカウントグループはもう存在しません。アカウント一覧を更新して再試行してください。',
      groupMemberNotFound: 'このアカウントはもうグループのメンバーではありません。アカウント一覧を更新して再試行してください。',
      profileNotFound: 'この接続アカウントはもう存在しません。アカウント一覧を更新して再試行してください。',
      activeProfileNotMember: '有効なグループメンバーだけをアクティブにできます。',
      fallbackDisabled: 'このサーバーではアカウントフォールバックが無効です。',
      duplicateMember: 'このアカウントはすでにグループに含まれています。',
      groupAlreadyExists: 'この id のアカウントグループはすでに存在します。',
      invalidGroup: 'このアカウントグループは無効です。設定を確認して再試行してください。',
      requestFailedWithStatus: ({ status }: { status: number }) => `The connected-service request failed (${status}). Refresh and try again.`,
      generic: '接続サービスの操作に失敗しました。更新して再試行してください。',
    },
    diagnostics: {
      title: {
        provider_session_state_unavailable_for_resume: '切り替えできません',
        connected_service_materialization_identity_missing: '接続サービスの識別情報がありません',
        resume_reachability_inputs_missing: 'セッション再開を確認できません',
        metadata_update_failed: '認証の選択が保存されませんでした',
        no_eligible_group_member: '利用できるフォールバックアカウントがありません',
        recovery_retry_scheduled: 'プロバイダーの復旧が予定されています',
                recovery_dead_lettered: 'プロバイダーの復旧に対応が必要です',
                provider_account_adoption_mismatch: 'プロバイダーがアカウントを切り替えませんでした',
                post_switch_verification_failed: 'プロバイダーアカウントを確認できませんでした',
                connected_service_credential_reconnect_required: "接続済みアカウントの再接続が必要です",
                connected_service_credential_refresh_unavailable: "接続済みアカウントの更新は一時的に利用できません",
                claude_subscription_missing_claude_code_scope: 'Claude Code のアクセスには再接続が必要です',
        claude_subscription_native_auth_materialization_failed: 'Claude Code の認証情報を準備できませんでした',
        claude_subscription_setup_token_not_supported_for_unified: 'Claude のセットアップトークンでは Unified モードを開始できません',
      },
      status: {
        providerSessionStateUnavailableForResume: "セッション状態を引き継げませんでした",
        providerAccountAdoptionMismatch: "プロバイダーが別のアカウントのままです",
        postSwitchVerificationFailed: "プロバイダーアカウントを確認できませんでした",
        recoveryRetryScheduled: "プロバイダー復旧の再試行を予約しました",
        metadataUpdateFailed: "認証選択を保存できませんでした",
        noEligibleGroupMember: "利用可能なフォールバックアカウントがありません",
        provider_session_state_unavailable_for_resume: 'セッション状態を引き継げませんでした',
        connected_service_materialization_identity_missing: '接続サービスの識別情報がありません',
        resume_reachability_inputs_missing: 'セッション再開を確認できません',
        metadata_update_failed: 'セッションの認証選択を保存できませんでした',
        no_eligible_group_member: 'フォールバック対象のアカウントがありません',
        recovery_retry_scheduled: 'プロバイダー復旧の再試行が予定されています',
                recovery_dead_lettered: 'プロバイダー復旧が再試行上限に達しました',
                provider_account_adoption_mismatch: 'プロバイダーは別のアカウントのままです',
                post_switch_verification_failed: 'プロバイダーアカウントを確認できませんでした',
                connected_service_credential_reconnect_required: "接続済みアカウントの再接続が必要です",
                connected_service_credential_refresh_unavailable: "接続済みアカウントの更新が一時的に失敗しました",
                claude_subscription_missing_claude_code_scope: 'Claude Code 用に Claude サブスクリプションを再接続してください',
        claude_subscription_native_auth_materialization_failed: 'Claude Code のネイティブ認証を準備できませんでした',
        claude_subscription_setup_token_not_supported_for_unified: 'Unified モード用に OAuth で Claude を再接続してください',
      },
      body: {
        default: "接続済みアカウントを確認してから再試行してください。",
        provider_session_state_unavailable_for_resume: '接続済みアカウントを確認し、選択したアカウントで新しく開始するか、現在のアカウントで続行してください。',
        connected_service_materialization_identity_missing: 'このセッションには、マテリアライズ済みのプロバイダー状態を再利用するために必要な接続サービスの識別情報がありません。選択したアカウントで新しく開始するか、現在のアカウントで続行してください。',
        resume_reachability_inputs_missing: '必要な再開情報が不足していたため、デーモンはプロバイダーの再開状態を確認できませんでした。',
        metadata_update_failed: 'セッションは新しい認証選択を保存できませんでした。セッションの同期が完了してからもう一度お試しください。',
        no_eligible_group_member: 'このグループには現在フォールバック対象のアカウントがありません。接続済みアカウントを確認し、必要に応じてプロファイルを再接続してください。',
        recovery_retry_scheduled: 'Happier はプロバイダー復旧の再試行を予定しました。今すぐ再試行するか、接続済みアカウントを確認できます。',
                recovery_dead_lettered: 'Happier はプロバイダー復旧の自動再試行を使い切りました。接続済みアカウントを確認するか、選択したプロファイルを再接続してください。',
                provider_account_adoption_mismatch: '切り替え後もプロバイダーは別のアカウントのままでした。接続済みアカウントを確認するか、切り替えを再試行してください。',
                post_switch_verification_failed: 'Happier は、プロバイダーが選択したアカウントを採用したことを確認できませんでした。接続済みアカウントを確認するか、切り替えを再試行してください。',
                connected_service_credential_reconnect_required: "このセッションを再開するには、選択した接続済みアカウントを再接続する必要があります。プロファイルを再接続してから再試行してください。",
                connected_service_credential_refresh_unavailable: "選択した接続済みアカウントを更新できませんでした。しばらくしてからもう一度お試しください。",
                claude_subscription_missing_claude_code_scope: 'この Claude プロファイルは Claude Code のスコープが付与される前に接続されました。再接続してから、セッションまたはグループ切り替えを再試行してください。',
        claude_subscription_native_auth_materialization_failed: 'Happier はこのプロファイル用の Claude Code ネイティブ認証情報ファイルを作成できませんでした。プロファイルを再接続するか、別のグループメンバーを選択してください。',
        claude_subscription_setup_token_not_supported_for_unified: 'Claude Unified モードでは、ネイティブ OAuth 認証情報で Claude CLI を起動する必要があります。セットアップトークンではなく OAuth でこのプロファイルを再接続してください。',
      },
      actions: {
        viewLatestFork: "最新のフォークを表示",
        viewNativeFork: "ネイティブフォークを表示",
      },
    },
    reconnect: {
      identityMismatchTitle: '別のプロバイダーアカウントが検出されました',
      identityMismatchBody: 'この認証情報は別のプロバイダーアカウントに属しているようです。このプロファイルの保存済み ID を置き換える場合のみ続行してください。',
      identityMismatchConfirm: 'ID を置き換える',
      targetMismatch: 'この再接続は別の接続済みプロファイルの認証情報を返しました。対象のプロファイルから再接続をやり直してください。',
    },
    defaultAuth: {
      poolSuggestion: {
        body: ({ pool }: { pool: string }) => `${pool} プールを使うと、セッションがレート制限を回避してローテーションします。`,
        accept: "プールを使う",
        dismiss: "閉じる",
      },
      title: "デフォルトのバックエンド設定",
      footer:
        "新しいセッション開始時に各バックエンドが使う接続済みアカウントを選びます。",
      agentDetailTitle: "デフォルト認証",
      agentDetailFooter:
        "接続サービス設定で使われるものと同じデフォルト値を書き込みます。",
      rowDetail: "デフォルト",
      warning: {
        connected_profile_unavailable:
          "デフォルトの接続済みアカウントを使用できないため、ネイティブ認証を使います。",
        connected_group_unavailable:
          "デフォルトの接続済みグループを使用できないため、ネイティブ認証を使います。",
        connected_group_disabled:
          "ここでは接続済みグループが無効なため、ネイティブ認証を使います。",
        connected_service_unsupported:
          "このバックエンドはその接続サービスに対応していないため、ネイティブ認証を使います。",
      },
    },
    list: {
      empty: "接続済みサービスはまだありません。",
      connectedCount: ({ count }: { count: number }) => `${count} 件接続済み`,
      needsReauth: "再認証が必要",
      notConnected: "未接続",
    },
    providerStateSharing: {
      title: "プロバイダー状態の共有",
      footer: "接続済みサービスの認証は分離されたままです。設定とセッション状態は、プロバイダーが安全に対応している場合のみ共有できます。",
      configTitle: "プロバイダー設定を共有",
      agentConfigTitle: ({ agent }: { agent: string }) => `${agent} の設定共有`,
      configLinkedTitle: "現在の設定をリンク",
      configLinkedSubtitle: "対応している場合はリンクを使い、接続済みサービスのセッションが現在のプロバイダー設定を読むようにします。",
      configCopiedTitle: "設定スナップショットをコピー",
      configCopiedSubtitle: "認証を materialize するたびにプロバイダー設定をコピーします。",
      configIsolatedTitle: "設定を分離",
      configIsolatedSubtitle: "ネイティブのプロバイダー設定を接続済みサービスのホームと共有しません。",
      stateTitle: "プロバイダーのセッションと状態を共有",
      agentStateTitle: ({ agent }: { agent: string }) => `${agent} のセッションと状態共有`,
      stateEnabledSubtitle: "対応プロバイダーで、ネイティブ認証と接続済みサービス認証の間で同じセッションを再開できるようにします。",
      stateDisabledSubtitle: "プロバイダー固有の共有フローが有効でない限り、プロバイダーのセッションとローカル状態を分離します。",
      sharedStatePrivacyTitle: "プロバイダー状態を共有",
      sharedStatePrivacyBody: ({ agent }: { agent: string }) =>
        `${agent} は接続済みサービスのホームからローカルのプロバイダーセッションファイルを読む可能性があります。関連付けてもよいアカウントでのみ有効にしてください。`,
      unavailable: {
        notImplemented: "このプロバイダーでは共有をまだ利用できません。",
        dynamicDiagnosticsRequired: "共有を有効にする前に、実行時の利用可否チェックが必要です。",
      },
    },
    quota: {
      loading: "読み込み中…",
      error: ({ message }: { message: string }) => `エラー: ${message}`,
      lastUpdated: ({ time }: { time: string }) => `最終更新: ${time}`,
      lastUpdatedStale: ({ time }: { time: string }) => `最終更新: ${time} • 古い`,
      noData: "クォータデータはまだありません",
      planLabel: ({ plan }: { plan: string }) => `プラン: ${plan}`,
      remaining: ({ percent }: { percent: string }) => `残り ${percent}`,
      remainingWithReset: ({ percent, reset }: { percent: string; reset: string }) => `残り ${percent} · ${reset}後にリセット`,
      usageCount: ({ used, limit }: { used: number; limit: number }) => `${used}/${limit} 使用済み`,
      recoveryCreditTitle: ({ count }: { count: number }) => count === 1 ? '利用量リセットが1件あります' : `${count}件の利用量リセットがあります`,
      recoveryCreditSubtitle: '利用量リセットを適用して、使い切った上限をすぐに回復します。',
      recoveryCreditExpires: ({ time }: { time: string }) => `最も早い期限: ${time}。`,
      recoveryCreditApplying: '適用中…',
      recoveryCreditMachineUnavailable: 'この利用量リセットを今適用できるマシンがありません。',
      recoveryCreditNothingToReset: 'No exhausted usage window currently needs a reset.',
      recoveryCreditBadge: ({ count }: { count: number }) => count === 1 ? '1件のリセット' : `${count}件のリセット`,
      duration: {
        now: '今',
        outdated: '更新が必要',
        daysHours: ({ days, hours }: { days: number; hours: number }) => `${days}d ${hours}h`,
        hoursMinutes: ({ hours, minutes }: { hours: number; minutes: number }) => `${hours}h ${minutes}m`,
        hours: ({ hours }: { hours: number }) => `${hours}h`,
        minutes: ({ minutes }: { minutes: number }) => `${minutes}m`,
      },
    },
    account: {
      refreshA11y: '使用状況と制限を更新',
      usedDetail: ({ used, limit }: { used: string; limit: string }) => `${used}/${limit} 使用済み`,
      usageCaption: '使用量',
      resetsCaption: 'リセット',
      poolsLabel: 'プール',
      poolsCount: ({ count }: { count: number }) => count === 1 ? '1件のプール' : `${count}件のプール`,
      planEmailSubtitle: ({ plan, email }: { plan: string; email: string }) => `${plan} · ${email}`,
      activeMemberA11y: 'アクティブなアカウント',
      setActiveA11y: 'アクティブなアカウントに設定',
      memberEnabledLabel: 'アカウント有効',
      resets: {
        now: '今',
        inDays: ({ days }: { days: number }) => days === 1 ? '1日後' : `${days}日後`,
        available: '利用量リセットがあります',
        rowLabel: ({ date, countdown }: { date: string; countdown: string }) =>
          countdown ? `${date}に期限切れ · ${countdown}` : `${date}に期限切れ`,
        confirmTitle: '利用量リセットを適用しますか?',
        confirmMessage: 'この接続アカウントで利用可能なリセットを1件消費します。',
        confirmCta: 'リセットを適用',
        use: '使用',
      },
    },
    pools: {
      title: 'プール',
      autoBadge: '自動',
      manualBadge: '手動',
      memberWarningsA11y: ({ count }: { count: number }) =>
        count === 1 ? '1件のメンバーに確認が必要です' : `${count}件のメンバーに確認が必要です`,
      create: {
        title: 'プールを作成',
        subtitle: '接続アカウントをグループ化して自動フォールバックに使います。',
      },
      empty: {
        title: 'プールはまだありません',
        subtitle: '複数の接続アカウントへセッションを振り分けるプールを作成します。',
      },
      loadError: {
        title: "プールを読み込めませんでした",
        subtitle: "アカウントのプールを読み込めませんでした。接続を確認して、もう一度お試しください。",
        staleTitle: "最後に取得したプールを表示しています",
        staleSubtitle: "最新のプール一覧を更新できませんでした。もう一度お試しください。",
        retry: "再試行",
      },
      detail: {
        summaryTitle: '概要',
        summary: ({ count, strategy }: { count: number; strategy: string }) =>
          `${count}アカウント · ${strategy}`,
        membersTitle: 'メンバー',
        moveUp: '上へ移動',
        moveDown: '下へ移動',
        noMembersTitle: 'メンバーはまだありません',
        noMembersSubtitle: 'このプールに接続アカウントを追加します。',
        serverActiveStatusTitle: "サーバーに保存済み",
        serverActiveStatusSubtitle: "これはサーバー上の永続的なアクティブアカウントです。オフラインのマシンは再接続時に適用します。この画面は、すべてのマシンへの反映完了を示すものではありません。",
        manualApplyDivergenceTitle: "サーバーでは切り替わりましたが、実行中のセッションには未適用です",
        manualApplyDivergenceSubtitle: ({ detail }: { detail: string }) => `アクティブなアカウントはサーバーで変更されましたが、実行中のセッションへの適用に失敗しました（${detail}）。再試行するか、元に戻してすべてを前のアカウントに保ってください。`,
        manualApplyRetry: "実行中のセッションへの適用を再試行",
        manualApplyRevert: "前のアカウントに戻す",
        machineTarget: {
            title: "実行中のセッションに適用できません",
            noBoundSession: "現在このプールを使用している実行中のセッションがないため、切り替えをライブで適用できません。このプールでセッションを開始してから、もう一度お試しください。",
            offline: "このプールのセッションを実行しているマシンがオフラインのため、切り替えを反映できません。マシンをオンラインに戻してから、もう一度お試しください。",
        },
        behaviorTitle: '動作',
        advancedTitle: '詳細',
        advancedSubtitle: 'フォールバックのトリガーと復旧動作を細かく調整します。',
      },
      behavior: {
        autoRestorePrimaryTitle: 'リセット後にプライマリへ戻す',
        autoRestorePrimarySubtitle: 'プライマリアカウントの利用上限がリセットされたら戻します。',
        switchOnGroupSubtitle: 'この条件で自動プール切り替えを実行できるようにします。',
        switchOn: {
          usageLimit: '利用上限',
          authExpired: '認証期限切れ',
          accountChanged: 'アカウント変更',
          refreshFailure: '更新失敗',
        },
      },
      delete: {
        title: 'プールを削除',
        subtitle: 'このプールとフォールバック設定を削除します。',
        confirmTitle: 'プールを削除しますか?',
        confirmMessage: ({ name }: { name: string }) =>
          `${name}を削除しますか? セッションはこのプールを使わなくなります。`,
      },
    },
    oauthPaste: {
      invalidConfig: "接続済みサービスの設定が無効です。",
      connectWebGroupTitle: "接続（Web）",
      connectWebDescription:
        "認可URLを開き、ブラウザでOAuthを完了したら、最終的にリダイレクトされたURLをコピーしてHappierに貼り付けてください。",
      openAuthorizationUrl: "認可 URL を開く",
      opensInNewTab: "新しいタブで開きます",
      preparing: "準備中…",
      pasteRedirectUrl: "リダイレクト URL を貼り付け",
      pasteRedirectUrlPlaceholder: "リダイレクト URL を貼り付け",
      pasteRedirectUrlPromptBody:
        "OAuth を完了したら、ブラウザのアドレスバーに表示されている最終的なリダイレクト URL をコピーして、ここに貼り付けてください。",
      providerOverrides: {
        claudeSubscription: {
          connectWebDescription:
            "次の手順: 開いたページでサインインしてください。Claude は自動リダイレクトではなくコード文字列を表示する場合があります。",
          pasteRedirectUrlPromptBody:
            "1) 開いたページでサインインします。2) 最終URL または Claude に表示された完全な \"code#state\" をコピーします。3) 下の入力欄に貼り付けます。",
          pasteRedirectUrlPlaceholder: "リダイレクト URL または code#state を貼り付け",
          errors: {
            missingState:
              "OAuth state がありません。Claude がコードを表示した場合は、コードだけでなく完全な \"code#state\" をコピーしてください。",
          },
        },
      },
      tryDeviceInstead: "デバイス認証を試す",
      tryEmbeddedInstead: "アプリ内ブラウザを試す",
      working: "処理中…",
      alerts: {
        connectedTitle: "接続済み",
        connectedBody: ({ serviceId, profileId }: { serviceId: string; profileId: string }) =>
          `${serviceId}（${profileId}）を接続しました。`,
        failedToOpenUrl: "URL を開けませんでした",
        failedToConnect: "接続に失敗しました",
      },
      errors: {
        missingState: "リダイレクト URL に OAuth state がありません。",
        stateMismatch: "OAuth state が一致しません。",
      },
    },
    oauthEmbedded: {
      title: "接続（アプリ内ブラウザ）",
      description:
        "埋め込みブラウザでサインインを開始します。うまくいかない場合は、リダイレクトURL貼り付け方式を使ってください。",
      startButton: "サインインを開始",
    },
    deviceAuth: {
      invalidConfig: "接続済みサービスの設定が無効です。",
      title: "接続（デバイス）",
      description:
        "検証ページを開き、コードを入力して、接続が完了するまでこの画面を開いたままにしてください。",
      openVerificationUrl: "検証ページを開く",
      userCode: "ユーザーコード",
      securityHint:
        "ヒント:「コピー」をタップしてコードをコピーできます。入力するのは auth.openai.com のみで、誰とも共有しないでください。",
      deviceAuthDisabledHint:
        "検証ページでデバイスコード認可が無効と表示される場合は、ChatGPT の設定で「Enable device code authorization for Codex」を有効にして再試行してください。",
      preparing: "準備中…",
      waiting: "承認待ち…",
      polling: "承認を確認中…",
      usePasteInstead: "代わりにリダイレクトURLを貼り付ける",
      useBrowserInstead: "代わりにアプリ内ブラウザを使用する",
      alerts: {
        connectedTitle: "接続済み",
        connectedBody: ({ serviceId, profileId }: { serviceId: string; profileId: string }) =>
          `${serviceId}（${profileId}）を接続しました。`,
        failedToConnect: "接続に失敗しました",
        failedToStart: "デバイス認証の開始に失敗しました",
      },
    },
    detail: {
      segments: { accounts: "アカウント", pools: "プール" },
      unknownService: "不明な接続済みサービスです。",
      actionsGroupTitle: "操作",
      actions: {
        setDefault: "既定に設定",
        unsetDefault: "既定を解除",
        editLabel: "ラベルを編集",
        reconnect: "再接続",
        openAccount: "アカウントを開く",
      },
      setDefaultProfileTitle: "既定のプロファイルを設定",
      setDefaultProfileSubtitleDefault: ({ profileId }: { profileId: string }) =>
        `既定: ${profileId}`,
      setDefaultProfileSubtitleChoose:
        "既定で選択されるプロファイルを選択します",
      setProfileLabelTitle: "プロファイルラベルを設定",
      setProfileLabelSubtitle: "認証ピッカーに表示される任意のラベル",
      addOauthProfileSubtitle: "新しいアカウントプロファイルを接続",
      addOauthProfileDeviceTitle: "デバイス認証で追加",
      addOauthProfileDeviceSubtitle: "Web/リモート環境に推奨",
      addOauthProfilePasteTitle: "リダイレクト貼り付けで追加",
      addOauthProfilePasteSubtitle: "URL をコピー/貼り付けする手動フロー",
      addOauthProfileBrowserTitle: "アプリ内ブラウザで追加",
      addOauthProfileBrowserSubtitle: "対応環境では組み込みブラウザを使用",
      connectApiKeyTitle: "APIキーで接続",
      connectApiKeySubtitle: "Anthropic の API キーを貼り付け",
      connectSetupTokenTitle: "setup-token で接続",
      connectSetupTokenSubtitle: "Claude の setup-token（claude setup-token）を貼り付け",
      connectAccessTokenTitle: "アクセストークンで接続",
      connectAccessTokenSubtitle: "GitHub personal access token を貼り付け",
      openGithubTokenTemplateTitle: "GitHub トークンを作成",
      openGithubTokenTemplateSubtitle: "Happier に必要な権限を事前入力して GitHub を開く",
      disconnectConfirmBody: ({ service, profileId }: { service: string; profileId: string }) =>
        `「${service}（${profileId}）」を切断しますか？`,
      disconnectGroupCleanupConfirmBody: ({ service, profileId, groups }: { service: string; profileId: string; groups: string }) =>
        `「${service}（${profileId}）」を切断し、${groups} から削除しますか？`,
      prompts: {
        profileIdTitle: "プロファイルID",
        profileIdBody: "work / personal / alt のような短いラベルを使ってください。",
        apiKeyTitle: "API キー",
        apiKeyBody: "Anthropic の API キーを貼り付けてください。",
        apiKeyPlaceholder: "例: sk-ant-…",
        setupTokenTitle: "セットアップトークン",
        setupTokenBody: "Claude の setup-token（claude setup-token）を貼り付けてください。",
        setupTokenPlaceholder: "例: sk-ant-oat01-…",
        accessTokenTitle: "アクセストークン",
        accessTokenBody: "GitHub personal access token を貼り付けてください。PR とリポジトリ公開フローを実行できるように、Contents、Pull requests、Administration を読み取り/書き込みにした fine-grained token を使用してください。",
        accessTokenPlaceholder: "github_pat_…",
        profileLabelTitle: "プロファイルラベル",
        profileLabelBody: "任意。認証ピッカーに表示されます。",
        profileLabelPlaceholder: "仕事用アカウント",

        personalAccessTokenTitle: "個人アクセストークン",
        personalAccessTokenBody: "GitHub の Fine-grained 個人アクセストークンを貼り付けてください。",
        personalAccessTokenPlaceholder: "github_pat_…",
        apiTokenTitle: "API トークン",
        apiTokenBody: "プロバイダーの API トークンまたはアプリパスワードを貼り付けてください。",
        apiTokenPlaceholder: "API トークン",},
      alerts: {
        invalidProfileIdTitle: "無効なプロファイルID",
        invalidProfileIdBody:
          "英数字、ハイフン、アンダースコア（最大64）を使用してください。",
        unknownProfileTitle: "不明なプロファイル",
        unknownProfileBody: ({ profileId, service }: { profileId: string; service: string }) =>
          `「${profileId}」というプロファイルは ${service} に存在しません。`,
        failedToOpenTokenSetupUrl: "GitHub トークン設定を開けませんでした。",
      },
      profiles: {
        empty: "プロファイルはまだありません。",
        connected: "接続済み",
        defaultBadge: "既定",
        needsReauth: "再認証が必要",
      },
      groups: {
        title: "アカウントグループ",
        empty: "アカウントグループはまだありません。",
        subtitle: ({ count }: { count: number }) => `${count} アカウント`,
        subtitleWithActive: ({ profileId, count }: { profileId: string; count: number }) =>
          `アクティブ: ${profileId} • ${count} アカウント`,
        actionsTitle: "アカウントグループの操作",
        createTitle: "アカウントグループを作成",
        createSubtitle: "フォールバック復旧のために接続済みプロファイルをグループ化します。",
        noProfilesTitle: "接続済みプロファイルがありません",
        noProfilesBody: "アカウントグループを作成する前に、少なくとも 1 つのプロファイルを接続してください。",
        invalidGroupTitle: "無効なグループ ID",
        invalidGroupBody: "英数字、ドット、ハイフン、アンダースコアを使用してください（最大 64 文字）。",
        statusReady: "準備完了",
        statusSwitching: "切り替え中",
        statusExhausted: "使い切り",
        statusError: "エラー",
        statusUnknown: "不明",
        statusNeedsMembers: "有効なメンバーが必要",
        activeMember: ({ profileId }: { profileId: string }) => `アクティブ: ${profileId}`,
        enabledMembers: ({ enabled, total }: { enabled: number; total: number }) => `${enabled}/${total} 有効`,
        autoFallbackEnabled: "自動フォールバックオン",
        autoFallbackDisabled: "自動フォールバックオフ",
        strategyPriority: "優先順",
        strategyLeastLimited: "制限が少ないものを優先",
        strategyManual: "手動切り替え",
        priority: ({ priority }: { priority: string }) => `優先度 ${priority}`,
        cooldown: ({ time }: { time: string }) => `${time} までクールダウン`,
        memberActive: "アクティブメンバー",
        memberEnabled: "有効",
        memberDisabled: "無効",
        memberPriority: ({ priority }: { priority: number }) => `優先度 ${priority}`,
        memberExhaustedUntil: ({ time }: { time: string }) => `${time} まで枯渇`,
        memberQuotaExhaustedUntil: ({ time }: { time: string }) => `${time} まで使用制限`,
        memberRateLimitedUntil: ({ time }: { time: string }) => `${time} までレート制限`,
        memberCapacityLimitedUntil: ({ time }: { time: string }) => `${time} まで容量制限`,
        memberAuthInvalidUntil: ({ time }: { time: string }) => `${time} まで認証無効`,
        memberPlanUnavailableUntil: ({ time }: { time: string }) => `${time} までプラン利用不可`,
        memberValidationBlockedUntil: ({ time }: { time: string }) => `${time} まで検証ブロック`,
        memberLastFailure: ({ reason }: { reason: string }) => `最後の問題: ${reason}`,
        warningNoEnabledMembers: "フォールバックに使える有効なメンバーがありません。",
        warningNoFallbackMember: "自動フォールバックでアカウントを切り替えるには、別のメンバーを追加または有効化してください。",
        deleteTitle: "アカウントグループを削除しますか？",
        deleteBody: ({ groupId }: { groupId: string }) => `「${groupId}」を削除しますか？プロファイルは接続されたままです。`,
        prompts: {
          groupIdTitle: "グループ ID",
          groupIdBody: "team、work、fallback のような短いラベルを使ってください。",
          groupIdPlaceholder: "chimu",
        },
      },
      groupActions: {
        editTitle: "グループを編集",
        searchMembersPlaceholder: "プロファイルを検索",
        noProfilesAvailable: "利用可能な接続済みプロファイルがありません。",
        membersTitle: "メンバー",
        membersSubtitle: "このグループに含めるプロファイルを選択します。",
        accountFallbackDisabled: "このサーバーでは自動フォールバックが無効です。",
        enableFallback: "自動フォールバックを有効化",
        disableFallback: "自動フォールバックを無効化",
        makeActive: "アクティブにする",
        useManualStrategy: "手動切り替えを使う",
        usePriorityStrategy: "優先順を使う",
        activeMember: "アクティブメンバー",
        manualApplyFailedTitle: "アカウントは切り替わりましたが、デーモン更新が未完了です",
        manualApplyFailedBody: "サーバー上のアクティブなアカウントは変更されましたが、実行中のローカルセッションの一部を更新できませんでした。以前のアカウントを使い続ける場合は、そのセッションを再起動または再開してください。",
        enableMember: "メンバーを有効化",
        disableMember: "メンバーを無効化",
        editPriority: "優先度を編集",
        priorityTitle: "メンバー優先度",
        priorityBody: "小さい数字から先に試します。",
        invalidPriorityTitle: "無効な優先度",
        invalidPriorityBody: "整数を入力してください。",
        removeMember: "メンバーを削除",
        removeMemberConfirmTitle: "メンバーを削除",
        removeMemberConfirmBody: ({ profileId }: { profileId: string }) => `このグループから「${profileId}」を削除しますか？`,
        runtimeFallbackUnsupported: 'この接続済みサービスでは自動フォールバックを利用できません。',
        removeMembersConfirmBody: ({ count, members }: { count: number; members: string }) => `このプールから${count === 1 ? "このメンバー" : `${count} 人のメンバー`}を削除しますか？\n\n${members}`,
        manageMembersTitle: 'メンバーを管理',
        manageMembersSubtitle: ({ count, total }: { count: number; total: number }) => `${total} 件中 ${count} 件のアカウント`,
      },
      groupDetail: {
        routeTitle: "グループ",
        nameTitle: "グループ名",
        namePromptBody: "設定と認証ピッカーに表示する名前を選んでください。",
        groupIdTitle: "グループ ID",
        membersTitle: "メンバー",
        membersSubtitle: ({ enabled, total }: { enabled: number; total: number }) => `${enabled}/${total} 有効`,
        optionsTitle: "オプション",
        autoSwitchTitle: "自動フォールバック",
        autoSwitchEnabledSubtitle: "アクティブなアカウントに回復が必要なとき、別のメンバーへ切り替えます。",
        autoSwitchDisabledSubtitle: "手動で切り替えるまでアクティブなメンバーを使い続けます。",
        strategyTitle: "選択戦略",
        strategyPriorityTitle: "優先順",
        strategyPrioritySubtitle: "優先度の小さい番号から先に試します。",
        strategyLeastLimitedTitle: "制限が少ない順",
        strategyLeastLimitedSubtitle: "使用可能なクォータが最も多いメンバーを優先します。",
        strategyManualTitle: "手動切り替え",
        strategyManualSubtitle: "手動で変更されるまでアクティブなメンバーだけを使います。",
        softSwitchThresholdTitle: "ソフト切り替えしきい値",
        softSwitchThresholdSubtitle: ({ percent }: { percent: string }) => `より安全なメンバーがある場合、残り ${percent}% 未満で切り替えます。`,
        softSwitchThresholdPromptTitle: "ソフト切り替えしきい値",
        softSwitchThresholdPromptBody: "Happier がより安全なアカウントを優先する残りパーセントを入力します。0 にするとソフト切り替えを無効にします。",
        invalidSoftSwitchThresholdTitle: "しきい値が無効です",
        invalidSoftSwitchThresholdBody: "0 から 100 までの数値を入力してください。",
        staleProbeTitle: "古いクォータを再確認するまで",
        staleProbeSubtitle: ({ minutes }: { minutes: string }) => `クォータデータが ${minutes} 分より古い場合に再確認します。`,
        staleProbePromptTitle: "古いクォータを再確認するまで",
        staleProbePromptBody: "Happier が再確認するまでクォータデータを再利用できる分数を入力します。",
        invalidStaleProbeTitle: "確認間隔が無効です",
        invalidStaleProbeBody: "1 分以上を入力してください。",
        switchBudgetTitle: "自動切り替えの上限",
        switchBudgetSubtitle: ({ perTurn, perHour }: { perTurn: string; perHour: string }) => `1 ターンあたり最大 ${perTurn} 回、セッション 1 時間あたり最大 ${perHour} 回の自動切り替え。`,
        recoveryModeTitle: "復旧モード",
        recoveryModeOffSubtitle: "このグループを自動的に復旧しません。",
        recoveryModeWaitUntilResetSubtitle: "制限のリセットを待ってから再開します。",
        recoveryModeSwitchThenResumeSubtitle: "別のメンバーに切り替えてから再開します。",
        recoveryModeSwitchOrWaitSubtitle: "可能なら別のメンバーに切り替え、できない場合はリセットを待ちます。",
        recoveryPromptTitle: "回復プロンプト",
        recoveryPromptSubtitle: "このグループでは標準の回復および再開プロンプトを使います。",
        missingTitle: "グループが見つかりません",
        missingBody: ({ service, groupId }: { service: string; groupId: string }) =>
          `${service} に「${groupId}」というグループはありません。`,
      },

      connectPersonalAccessTokenTitle: "個人アクセストークンで接続",
      connectPersonalAccessTokenSubtitle: "Fine-grained 個人アクセストークンを貼り付け",
      connectApiTokenTitle: "API トークンで接続",
      connectApiTokenSubtitle: "プロバイダーの API トークンまたはアプリパスワードを貼り付け",
      openTokenSetupTitle: "トークン設定を開く",
      openTokenSetupSubtitle: "プロバイダーの設定ページを開く",
      openPersonalAccessTokenSetupTitle: "個人アクセストークンを作成",
      openPersonalAccessTokenSetupSubtitle: "GitHub fine-grained トークン設定を開く",},
    profile: {
      profileId: "プロファイルID",
      status: "状態",
      email: "メール",
      accountId: "アカウントID",
      providerAccountId: "プロバイダーのアカウントID",
      quotaTitle: "クォータ",
      defaultSubtitle: "このプロファイルは既定で選択されています",
      setDefaultSubtitle: "このプロファイルを既定で使用します",
      disconnectSubtitle: "このプロファイルの資格情報を削除します",
      reconnectSubtitle: "このプロファイルを再認証します",
      replaceTokenSubtitle: "このプロファイルの資格情報を置き換えます",
      connectionGroupTitle: "接続",
      connectedVia: "接続方法",
      connectedViaToken: "アクセストークン",
      connectedViaOauth: "OAuth",
      lastRefreshed: "最終更新",
      refreshQuotaNow: "クォータを今すぐ更新",
      refreshQuotaNowSubtitle: "このアカウントの最新の使用状況を取得します。",
      poolsGroupTitle: "プール",
      pools: {
        emptyTitle: "どのプールにも未所属",
        emptySubtitle: "このアカウントをプールに追加すると自動フォールバックできます。",
      },
      addToPool: "プールに追加",
      addToPoolSubtitle: "このアカウントをプールのフォールバックとして使います。",
      settingsGroupTitle: "設定",
      setDefaultRowTitle: "既定に設定",
      removeGroupTitle: "削除",
    },
    authModal: {
      nativeAuthTitle: "バックエンドのネイティブ認証",
      nativeAuthSubtitle: "ローカルCLIログイン / APIキーを使用",
            groupSubtitle: 'アカウントグループ',
      connectedServicesTitle: "接続済みサービスを使用",
      connectedServicesSubtitle: "Happierクラウドから取得して反映",
      notConnectedTitle: "接続済みサービスなし",
      notConnectedSubtitle: "タップして設定を開く",
      profileLabel: "プロファイル",
    },
  },

  attachments: {
    alerts: {
      fileTooLargeTitle: "ファイルが大きすぎます",
      fileTooLargeBody: ({ count }: { count: number }) =>
        `最大添付サイズを超えるため、${count} 件のファイルをスキップしました。`,
      noClipboardImageTitle: "クリップボードに画像がありません",
      noClipboardImageBody: "画像をコピーしてから、添付ファイルとして貼り付けてください。",
    },
  },

  settingsAttachments: {
    disabled: {
      title: "添付ファイル",
      footer: "この機能はサーバーまたはビルドポリシーによって無効化されています。",
    },
    fileUploads: {
      title: "ファイルアップロード",
    },
    uploadLocation: {
      title: "アップロード先",
      footer:
        "ワークスペースへのアップロードが最も互換性があります。OS の一時ディレクトリへのアップロードはリポジトリアーティファクトを避けるのに役立ちますが、より厳しいサンドボックスでは読み取れない場合があります。",
      options: {
        workspace: {
          title: "ワークスペースのディレクトリ（推奨）",
          subtitle:
            "アップロードはワークスペース相対ディレクトリに書き込まれるため、エージェントのサンドボックスが確実に読み取れます。",
        },
        osTemp: {
          title: "OS の一時ディレクトリ",
          subtitle:
            "アップロードは OS の一時ディレクトリに書き込まれます。より厳しいサンドボックスでは問題になる場合があります。",
        },
      },
    },
    workspaceDirectory: {
      title: "ワークスペースのディレクトリ",
      footer:
        "アップロード先がワークスペースのディレクトリに設定されている場合のみ使用されます。",
      uploadsDirectory: {
        title: "アップロード用ディレクトリ",
        promptTitle: "アップロード用ディレクトリ",
        promptMessage:
          "ワークスペース相対のディレクトリを入力してください（絶対パス不可、.. 不可）。",
        invalidDirectoryTitle: "無効なディレクトリ",
        invalidDirectoryMessage:
          ".happier/uploads のような相対パスを使用してください。",
      },
    },
    sourceControlIgnore: {
      title: "バージョン管理の無視設定",
      footer:
        "ローカルのみの無視設定は誤ってコミットするのを防ぎます。.gitignore を選ぶと追跡ファイルが変更される可能性があります。",
      options: {
        gitInfoExclude: {
          title: "ローカルで無視（.git/info/exclude）（推奨）",
          subtitle:
            "リポジトリのファイルを変更せずに誤コミットを防ぎます。",
        },
        gitignore: {
          title: ".gitignore で無視",
          subtitle:
            "ワークスペースの .gitignore にエントリを書き込みます（コミットされる可能性があります）。",
        },
        none: {
          title: "無視ルールを書き込まない",
          subtitle:
            "リポジトリ設定によってはアップロードがバージョン管理に拾われる場合があります。",
        },
      },
      writeIgnoreRules: {
        title: "無視ルールを書き込む",
      },
    },
    limits: {
      title: "制限",
      footer:
        "これらの制限はローカルの CLI アップロードハンドラで（ベストエフォートで）適用されます。",
      invalidValueTitle: "無効な値",
      maxAttachmentSize: {
        title: "添付の最大サイズ（バイト）",
        promptTitle: "添付の最大サイズ（バイト）",
        promptMessage: "例: 25MB の場合は 26214400。",
        invalidValueMessage: "1024 から 1073741824 の間の数値を入力してください。",
      },
    },
  },

  settingsSourceControl: {
  title: 'ファイルとソース管理',
  editor: 'エディタ',
  editorFooter: 'ファイルエディタの動作を設定します。',
  editorAutoSave: '自動保存',
  editorAutoSaveDescription: '編集後にファイルを自動的に保存します。',
  markdownEditMode: {
    title: 'デフォルトの Markdown 編集モード',
    footer: 'Markdown ファイルを編集用に開く方法を選択します。リッチは WYSIWYG エディタを提供し、ローは Markdown ソースを直接編集します。安全に往復変換できないファイルは常にローで開きます。',
    options: {
      rich: {
        title: 'リッチ (WYSIWYG)',
        subtitle: 'ライブ書式設定で Markdown を視覚的に編集します。',
      },
      raw: {
        title: 'ローテキスト',
        subtitle: 'Markdown ソースを直接編集します。',
      },
    },
    disabledReason: {
      mdx: 'これは MDX ファイルのため、ローテキストとして編集しています。',
      tooLarge: 'このファイルはリッチエディタには大きすぎるため、ローテキストとして編集しています。',
      referenceLinks: 'このファイルには参照スタイルのリンクが含まれているため、ローテキストとして編集しています。',
      footnotes: 'このファイルには脚注が含まれているため、ローテキストとして編集しています。',
      htmlOrJsx: 'このファイルには HTML または JSX が含まれているため、ローテキストとして編集しています。',
    },
  },
    commitStrategy: {
      title: "コミット戦略",
      footer:
        "アトミックコミットは複数エージェントによるインデックス干渉を避けます。Git のステージングは include/exclude の対話的ワークフローを有効にします。",
      options: {
        atomic: {
          title: "アトミックコミット（推奨）",
          subtitle:
            "リポジトリインデックスでのライブステージングはありません。保留中の変更を 1 回の RPC 操作でまとめてコミットします。",
        },
        gitStaging: {
          title: "Git ステージングワークフロー",
          subtitle:
            "Git リポジトリで include/exclude と行単位の部分ステージングを有効にします。",
        },
      },
    },
    gitRoutingPreference: {
      title: ".git ルーティングの優先設定",
      footer:
        "リポジトリモードが .git のときに優先するバックエンドを選択します。",
      options: {
        git: {
          title: ".git リポジトリは Git を使用",
          subtitle: "互換性のための既定かつ推奨です。",
        },
        sapling: {
          title: ".git リポジトリは Sapling を優先",
          subtitle: "Git と Sapling の両方が利用可能な場合に Sapling を使用します。",
        },
      },
    },
    remoteConfirmation: {
      title: "リモート操作の確認",
      footer:
        "pull/push 操作に確認が必要かどうかを制御します。",
      pull: {
        title: "pull の前に確認",
        subtitle: "リモート変更を取り込む前に確認を表示します。",
      },
      push: {
        title: "push の前に確認",
        subtitle: "ローカルコミットを送信する前に確認を表示します。",
      },

      confirmBeforePulling: {
        title: "pull の前に確認",
        subtitle: "リモートの変更を取得して統合する前に確認します。",
      },
      confirmBeforePushing: {
        title: "push の前に確認",
        subtitle: "ローカルコミットをリモートにアップロードする前に確認します。",
      },
      options: {
        always: {
          title: "常に pull/push を確認",
          subtitle: "pull と push の操作で確認ダイアログを表示します。",
        },
        pushOnly: {
          title: "push のみ確認",
          subtitle: "pull はすぐ実行され、push は確認が必要です。",
        },
        never: {
          title: "確認しない",
          subtitle: "pull と push をすぐに実行します。",
        },
      },},
    pushRejectionRecovery: {
      title: "push 拒否時の復旧",
      footer:
        "ブランチが upstream より遅れているため push が拒否されたときの挙動です。",
      options: {
        promptFetch: {
          title: "fetch を確認する",
          subtitle:
            "non-fast-forward で push が拒否された場合、fetch 実行前に確認します。",
        },
        autoFetch: {
          title: "自動 fetch",
          subtitle:
            "non-fast-forward の push 拒否後に自動で fetch を実行します。",
        },
        manual: {
          title: "手動復旧",
          subtitle: "push の拒否後に fetch を自動実行しません。",
        },
      },
    },
    commitMessageGenerator: {
      title: "コミットメッセージ生成",
      footer:
        "任意: 1 回限りの LLM タスクでコミットメッセージ候補を生成します。デーモンで execution runs のサポートが必要です。",
      backendItemTitle: ({ backendId }: { backendId: string }) =>
        `生成バックエンド: ${backendId}`,
      backendItemSubtitle:
        "1 回限りのコミットメッセージ生成に使用するバックエンド ID。",
      backendPromptTitle: "コミットメッセージのバックエンド",
      backendPromptMessage: "バックエンド ID を入力",
      instructionsPlaceholder: "コミットメッセージの指示",
    },
    commitAttribution: {
      title: "コミットのクレジット",
      footer:
        "有効にすると、AI が生成したコミットメッセージに Co-Authored-By クレジットが追加されます。",
      includeCoAuthoredBy: {
        title: "Co-Authored-By を含める",
      },
    },
    filesDisplay: {
      title: "ファイル表示",
      footer:
        "構文ハイライトは実験的で、非常に大きい diff では無効になる場合があります。",
      diffRenderer: {
        options: {
          pierre: {
            title: "Diff レンダラー: Pierre",
            subtitle:
              "web/desktop で最高の diff 表示。worker パイプラインを使用し、利用できない場合は安全にフォールバックします。",
          },
          happier: {
            title: "Diff レンダラー: Happier",
            subtitle: "互換性とトラブルシューティング向けのフォールバック表示です。",
          },
        },
      },
      diffPresentation: {
        options: {
          unified: {
            title: "差分レイアウト: 統合",
            subtitle: "インライン表示（1列）。狭い画面や素早い確認に最適です。",
          },
          split: {
            title: "差分レイアウト: 左右",
            subtitle: "左右分割表示（2列）。大きい画面での精密な比較に最適です。",
          },
        },
      },
      syntaxHighlighting: {
        options: {
          off: {
            title: "構文ハイライト: オフ",
            subtitle: "diff とファイルをプレーンな等幅テキストで表示します。",
          },
          simple: {
            title: "構文ハイライト: シンプル",
            subtitle: "一般的な言語向けの高速なトークンベースのハイライトです。",
          },
          advanced: {
            title: "構文ハイライト: 高度",
            subtitle:
              "web/desktop でより高精度。native ではシンプルにフォールバックします。",
          },
        },
      },
      changedFilesDensity: {
        options: {
          comfortable: {
            title: "変更ファイル密度: 快適",
            subtitle: "行が大きく、ファイルのサブタイトルとステータスが見やすくなります。",
          },
          compact: {
            title: "変更ファイル密度: コンパクト",
            subtitle: "変更が多いときにスキャンしやすい小さめの行です。",
          },
        },
      },
    },
    backends: {
      backendGroupTitle: ({ backendTitle }: { backendTitle: string }) =>
        `${backendTitle} バックエンド`,
      defaultDiffItemTitle: ({
        backendTitle,
        diffModeTitle,
      }: {
        backendTitle: string;
        diffModeTitle: string;
      }) => `${backendTitle} の既定 diff: ${diffModeTitle}`,
      defaultDiffItemSubtitle:
        "含まれる差分と保留中の差分を表示するときの既定モードです。",
    },
    diffMode: {
      pending: "保留中",
      combined: "結合",
      included: "含めた",
    },
  },

  settingsDesktop: {
    title: 'デスクトップ',
    footer: 'このコンピューター上の Tauri デスクトップ連携を管理します。',
    startOnLoginTitle: 'ログイン時に起動',
    startOnLoginSubtitle: 'このコンピューターにサインインしたときに Happier を自動的に起動します。',

    overlay: {
      title: 'Desktop overlay',
      footer: 'Controls the local floating activity surface on this device.',
      enabledTitle: 'Enable desktop overlay',
      enabledSubtitle: 'Show a local floating activity surface on this device',
      visibilityModeTitle: 'Visibility mode',
      visibilityModeSubtitle: 'Choose when the overlay should appear',
      visibilityAttentionOnlyTitle: 'Attention only',
      visibilityActiveSessionsTitle: 'Active sessions',
      visibilityAlwaysWhenEnabledTitle: 'Always when enabled',
      showWhenRunningTitle: 'Show when running',
      showWhenRunningSubtitle: 'Show the overlay while sessions are running',
      showWhenAttentionRequiredTitle: 'Show when attention is required',
      showWhenAttentionRequiredSubtitle: 'Show the overlay when a session needs your input',
      showWhenReadyTitle: 'Show when ready',
      showWhenReadySubtitle: 'Show the overlay when a turn finishes and waits for input',
      alwaysOnTopTitle: 'Always on top',
      alwaysOnTopSubtitle: 'Keep the overlay above other windows',
      interactionTitle: 'Interaction',
      interactionFooter: 'Choose how the overlay behaves while it is visible.',
      autoHideEnabledTitle: 'Auto-hide',
      autoHideEnabledSubtitle: 'Hide the overlay after it has been idle',
      autoHideDelayTitle: 'Auto-hide delay',
      autoHideDelaySubtitle: 'Choose how long the overlay waits before hiding',
      autoHideDelay3sTitle: '3 seconds',
      autoHideDelay6sTitle: '6 seconds',
      autoHideDelay10sTitle: '10 seconds',
      autoHideDelay30sTitle: '30 seconds',
      expandedBehaviorTitle: 'Expanded behavior',
      expandedBehaviorSubtitle: 'Choose how the overlay expands',
      expandedBehaviorClickTitle: 'Click',
      expandedBehaviorHoverTitle: 'Hover',
      expandedBehaviorShortcutOnlyTitle: 'Shortcut only',
      interactiveCollapsedTitle: 'Collapsed is interactive',
      interactiveCollapsedSubtitle: 'Allow the collapsed overlay to respond to clicks',
      collapsedClickActionTitle: 'Collapsed click action',
      collapsedClickActionSubtitle: 'Choose what the overlay does when collapsed',
      collapsedClickActionExpandOverlayTitle: 'Expand overlay',
      collapsedClickActionOpenPrimarySessionTitle: 'Open primary session',
      collapsedClickActionOpenSessionsTitle: 'Open sessions list',
      placementTitle: 'Placement',
      placementFooter: 'Choose where the overlay sits on the screen.',
      presentationModeTitle: 'Presentation mode',
            presentationModeSubtitle: 'Choose whether the overlay follows the display notch or floats freely',
            presentationAutomaticTitle: 'Automatic',
            presentationNotchIntegratedTitle: 'Notch-integrated',
            presentationFloatingOverlayTitle: 'Floating overlay',
            hostModeFallbackTitle: 'Host mode: Floating overlay',
            hostModeFallbackSubtitle: 'Notch-integrated mode is unavailable on this display, so the overlay falls back to a floating overlay.',
            placementModeTitle: 'Placement mode',
            placementModeSubtitle: 'Switch between anchored and custom placement',
      placementAnchoredTitle: 'Anchored',
      placementCustomTitle: 'Custom',
      anchorPresetTitle: 'Anchor preset',
      anchorPresetSubtitle: 'Pick the anchor used for the overlay position',
      anchorTopCenterTitle: 'Top center',
      anchorTopLeftTitle: 'Top left',
      anchorTopRightTitle: 'Top right',
      anchorBottomCenterTitle: 'Bottom center',
      anchorBottomLeftTitle: 'Bottom left',
      anchorBottomRightTitle: 'Bottom right',
      anchorLeftCenterTitle: 'Left center',
      anchorRightCenterTitle: 'Right center',
      allowRepositioningTitle: 'Allow repositioning',
      allowRepositioningSubtitle: 'Let the overlay be dragged into a custom position',
      lockPositionTitle: 'Lock position',
      lockPositionSubtitle: 'Keep the overlay fixed in place',
      resetPositionTitle: 'Reset position',
      resetPositionSubtitle: 'Return to the default anchored position',
      presentationTitle: 'Presentation',
      presentationFooter: 'Tune how the overlay looks when it is collapsed.',
      densityTitle: 'Density',
      densitySubtitle: 'Choose the amount of spacing used in the overlay',
      densityCompactTitle: 'Compact',
      densityComfortableTitle: 'Comfortable',
      compactStyleTitle: 'Compact style',
      compactStyleSubtitle: 'Choose the shape used for the collapsed overlay',
      compactStylePillTitle: 'Pill',
      compactStylePanelTitle: 'Panel',
      showSessionCountTitle: 'Show session count',
      showSessionCountSubtitle: 'Show how many sessions are currently represented',
      showPreviewTextTitle: 'Show preview text',
      showPreviewTextSubtitle: 'Show the latest preview text when space allows',
    },},

  settingsPets: {
    title: 'ペット',
    previewTitle: 'Blink コンパニオン',
    previewSubtitle: 'セッション状態とレビューの注意事項を知らせる小さなコンパニオンです。',
    disabledTitle: 'ペットは無効です',
    disabledSubtitle: 'このデバイスでコンパニオンを使うには、機能でペットを有効にしてください。',
    disabledByServerTitle: 'このサーバーではペットが無効です',
    disabledByServerSubtitle: '管理者がこのサーバーのペットコンパニオンを無効にしています。',
    accountTitle: 'アカウントの既定値',
    enabledTitle: 'ペットを有効化',
    enabledSubtitle: 'このアカウントでコンパニオン画面を表示します。',
    companionSizeTitle: 'ペットのサイズ',
    companionSizeSubtitle: 'このデバイスでのコンパニオンのサイズを調整します。',
    companionSizeValue: ({ percent }: { percent: number }) => `${percent}%`,
    deviceOverrideTitle: 'このデバイスで使用',
    deviceOverrideSubtitle: 'アカウントのペット設定をローカルで上書きします。',
    sourceTitle: 'ペットのソース',
    builtInSubtitle: 'Happier に組み込まれています。',
    builtInBlinkSubtitle: 'セッションの合図を落ち着いた小さなステータスライトに変えます。',
    builtInFurySubtitle: '本番に届く前に難しいワークフローをストレステストします。',
    builtInMiloSubtitle: 'UI を整え、失敗したテストの上で昼寝します。',
    builtInOliSubtitle: 'ビルドが気づく前にこっそり修正を出荷します。',
    builtInTitiSubtitle: 'シニアスタッフ並みの集中力でリリースノートを仕分けます。',
    localLibraryTitle: 'このデバイス',
    localLibraryFooter: 'ローカルのペットは、アカウントにインポートしない限りこのデバイスに留まります。',
    helpDocsTitle: 'ペットのヘルプ',
    helpDocsSubtitle: 'セットアップとトラブルシューティング用の Happier ドキュメントを開きます。',
    detectCodexPetsTitle: 'Codex ペットを検出',
    detectCodexPetsSubtitle: 'ローカルの Codex homes から互換ペットを探します。',
    detectedCodexPetsTileSubtitle: 'Codex で見つかり、このデバイスに参加する準備ができています。',
    detectedCodexPetsEmptyTitle: 'Codex ペットが見つかりません',
    detectedCodexPetsEmptySubtitle: 'Codex で作成してから、もう一度検出してください。',
    detectedCodexPetsErrorTitle: 'Codex ペットを検出できませんでした',
    detectedCodexPetsErrorSubtitle: 'daemon が接続されていることを確認してから、もう一度お試しください。',
    detectedCodexPetsNoTargetTitle: '利用できる daemon がありません',
    detectedCodexPetsNoTargetSubtitle: 'このコンピュータで Happier を起動してから、Codex ペットをもう一度検出してください。',
    detectedCodexPetsDaemonMismatchTitle: 'ペット検出のため daemon を更新してください',
    detectedCodexPetsDaemonMismatchSubtitle: 'この daemon はまだペット検出を公開していません。スタックを更新してからもう一度お試しください。',
    useOnThisDeviceTitle: 'このデバイスで使用',
    useOnThisDeviceSubtitle: 'アカウント既定値を変えずにローカルペットを選択します。',
    importedLocalSubtitle: 'このデバイスの Codex からインポート済み。',
    removeFromDeviceTitle: 'デバイスから削除',
    removeFromDeviceSubtitle: 'このローカルペットをこのデバイスから削除します。',
    accountLibraryTitle: 'アカウントライブラリ',
    accountLibraryFooter: '同期済みペットはサインイン済みデバイスで利用できます。',
    accountPetTileSubtitle: 'アカウントから同期済みです。',
    removeFromDeviceDaemonErrorTitle: 'ローカルでは削除済みですが、デーモンのクリーンアップに失敗しました',
    removeFromDeviceDaemonErrorSubtitle: ({ code }: { code: string }) => `このデバイスの一覧からペットを削除しましたが、デーモンのクリーンアップで ${code} が返されました。`,
    importToDeviceDaemonErrorTitle: 'ペットをインポートできませんでした',
    importToDeviceDaemonErrorSubtitle: ({ code }: { code: string }) => `デーモンがこのペットをインポートできませんでした。Codex ペットを再検出してからもう一度お試しください。(${code})`,
    importToAccountTitle: 'アカウントへインポート',
    importToAccountSubtitle: '互換性のあるローカルペットをアップロードして複数デバイスで使います。',
    desktopOverlayTitle: 'デスクトップオーバーレイ',
    overlayTrayTitle: 'ペットのアクティビティ',
    overlayStatusWaiting: '待機中',
    overlayStatusFailed: '失敗',
    overlayStatusReview: 'レビュー',
    overlayStatusRunning: '実行中',
    overlayQuickReplyPlaceholder: 'クイック返信',
    overlayReplyAction: '返信',
    overlayQuickReplyAction: 'クイック返信を送信',
    overlayDismissAction: 'アクティビティを閉じる',
    overlayTuckAction: 'しまう',
    overlayClosePetAction: 'ペットを閉じる',
    desktopOverlayEnabledTitle: 'デスクトップオーバーレイを有効化',
    desktopOverlayEnabledSubtitle: '透明なデスクトップコンパニオンウィンドウにペットを表示します。',
    desktopOverlayDeviceOverrideTitle: 'このデバイスのデスクトップオーバーレイ',
    desktopOverlayVisibilityModeTitle: 'このデバイスのオーバーレイ表示',
    desktopOverlayVisibilityModeSubtitle: 'デスクトップペットをローカルで表示するタイミングを選びます。',
    desktopOverlayResetPositionTitle: '位置をリセット',
    desktopOverlayResetPositionSubtitle: 'オーバーレイを右下隅に戻します。',
    overrideInherit: 'アカウント値',
    overrideEnabled: '有効',
    overrideDisabled: '無効',
    visibilityModeInherit: 'アカウント値',
    visibilityModeAlwaysWhenEnabled: '有効時は常に表示',
    visibilityModeAttentionOrActive: '注意またはアクティブ時',
    visibilityModeAttentionOnly: '注意時のみ',
  },

  settingsNotifications: {
    badges: {
      title: "このデバイスのバッジ",
      footer: "このデバイスのアプリアイコンバッジにどのアクティビティを反映するかを選択します。",
      enabledTitle: "バッジを有効化",
      enabledSubtitle: "注意が必要なアクティビティがあるときにアプリアイコンのバッジを表示します",
      unreadTitle: "未読セッション",
      unreadSubtitle: "未読のトランスクリプトアクティビティがあるセッションを数えます",
      permissionRequestsTitle: "権限リクエスト",
      permissionRequestsSubtitle: "承認待ちのセッションを数えます",
      userActionsTitle: "操作リクエスト",
      userActionsSubtitle: "回答または確認を待っているセッションを数えます",
      queuedTitle: "キュー済みのユーザー入力",
      queuedSubtitle: "まだ送信していないキュー済み作業があるセッションを数えます",
      friendRequestsTitle: "友達リクエスト",
      friendRequestsSubtitle: "受信した友達リクエストを数値バッジに追加します",
      desktopDotTitle: "デスクトップドックのドット",
      desktopDotSubtitle: "デスクトップでは、数値以外の受信箱アクティビティしかないときにドットを表示します",
    },
    local: {
      title: "このデバイスのローカル通知",
      footer: "これらの設定は、この特定のデバイスで通知がどのように表示されるかに影響します。",
      enabledSubtitle: "このデバイスでローカル通知を表示することを許可します",
      readyTitle: "準備完了",
      readySubtitle: "ターンが終了したときにローカル通知を表示します",
      readyPreviewTitle: "準備完了メッセージのプレビュー",
      readyPreviewSubtitle: "このデバイスの準備完了通知に最新のアシスタントメッセージを含めます",
      permissionRequestsTitle: "権限リクエスト",
      permissionRequestsSubtitle: "セッションが承認を必要とするときにローカル通知を表示します",
      userActionsTitle: "操作リクエスト",
      userActionsSubtitle: "セッションが入力を必要とするときにローカル通知を表示します",
    },
    desktop: {
      title: "デスクトップ通知",
      footer: "このデスクトップアプリのローカル通知配信を確認します。",
      permission: {
        title: "システム権限",
        checkingSubtitle: "macOS 通知権限を確認しています",
        grantedSubtitle: "macOS はこのアプリからの通知送信を許可しています",
        notGrantedSubtitle: "タップして macOS 通知権限をリクエスト",
        errorSubtitle: "macOS 通知権限を読み取れませんでした",
      },
    },
    push: {
      title: "プッシュ通知",
      footer:
        "これらの通知は、セッションに注意が必要なときに CLI から Expo 経由で送信されます。",
      enabledSubtitle: "このアカウントでプッシュ通知を許可します",
      troubleshootTitle: "トラブルシューティング",
      troubleshootSubtitle: "権限と登録済みデバイスを確認",
    },
    pushPriming: {
        title: '通知をオンにしますか？',
        body: 'エージェントの作業完了、権限の確認が必要なとき、応答待ちのときに Happier がお知らせします。設定でいつでも変更できます。',
        accept: 'オンにする',
        decline: '後で',
        blockedTitle: '通知がブロックされています',
        blockedBody: 'このアプリの通知はシステム設定でオフになっています。設定を開いて許可してください。',
        openSettings: '設定を開く',
        openSettingsFailed: 'システム設定を開けませんでした。',
    },
    pushTroubleshooting: {
      status: {
        title: "状態",
        footer: "アカウント設定、OS 権限、サーバー登録状態を確認します。",
        accountSettingTitle: "アカウント設定",
        accountSettingEnabledSubtitle: "このアカウントでプッシュ通知は有効です",
        accountSettingDisabledSubtitle: "このアカウントでプッシュ通知は無効です",
      },
      permission: {
        title: "権限",
        loading: "読み込み中…",
        loadingSubtitle: "通知権限を確認しています",
        runtimeUnavailable: '利用不可',
        runtimeUnavailableSubtitle: 'この端末で通知サービスに接続できませんでした。',
        runtimeTimeoutSubtitle: '通知サービスが応答しませんでした。開発サーバーへの接続を確認して再試行してください。',
        unsupported: "未対応",
        unsupportedSubtitle: "Web ではプッシュ権限を利用できません。",
        allowed: "許可",
        allowedSubtitle: "このアプリの通知が許可されています。",
        denied: "拒否",
        notRequested: "未リクエスト",
        canAskAgainSubtitle: "タップして権限をリクエストします。",
        openSettingsSubtitle: "タップしてシステム設定を開きます。",
      },
      token: {
        title: "このデバイス",
        subtitle: ({ fingerprint }: { fingerprint: string }) =>
          `現在のトークン: ${fingerprint}`,
        unavailableSubtitle: "Expo のプッシュトークンを取得できません。",
        checkingSubtitle: 'この端末のトークンを読み取っています…',
        runtimeUnavailableSubtitle: 'この端末で通知サービスに接続できませんでした。',
        runtimeTimeoutSubtitle: '通知サービスが時間内に応答しませんでした。',
        deviceUnavailableSubtitle: 'このビルドではプッシュトークンを取得できません。このビルドでプッシュ通知が有効か確認してください。',
        registered: "登録済み",
      },
      actions: {
        title: "操作",
        footer: "プッシュ通知が届かない場合は、次の手順を試してください。",
        requestPermissionTitle: "権限をリクエスト",
        requestPermissionSubtitle: "OS に通知権限をリクエストします。",
        reregisterTitle: "トークンを再登録",
        reregisterSubtitle: "このデバイスのトークンをサーバーへ再送信します。",
        refreshTitle: "更新",
        refreshSubtitle:
          "権限、トークン、サーバーのデバイス一覧を再読み込みします。",
      },
      devices: {
        title: "登録済みデバイス",
        footer: ({ count, serverUrl }: { count: string; serverUrl: string }) =>
          `${serverUrl} に ${count} 件のトークン`,
        emptyTitle: "デバイスがありません",
        emptySubtitle:
          "このアカウントでサーバーに登録されたプッシュトークンはありません。",
        clientServerUrl: ({ url }: { url: string }) => `サーバー: ${url}`,
        registeredAt: ({ at }: { at: string }) => `登録: ${at}`,
        lastSeenAt: ({ at }: { at: string }) => `最終確認: ${at}`,
        thisDevice: "このデバイス",
      },
      loadError: "プッシュ通知の状態を読み込めませんでした。",
      authRequired: "プッシュ通知を管理するにはサインインしてください。",
      remove: {
        confirmTitle: "デバイスを削除",
        confirmBody: ({ fingerprint }: { fingerprint: string }) =>
          `プッシュトークン ${fingerprint} を削除しますか？`,
        error: "プッシュトークンを削除できませんでした。",
      },
    },
    webhooks: {
      title: "Webhook 通知",
      footer: "このアカウントの追加 webhook エンドポイントへリモートアクティビティ通知を送信します。",
      addTitle: "Webhook を追加",
      addSubtitle: "別のエンドポイントへ通知を配信します",
      emptyTitle: "Webhook チャンネルがありません",
      emptySubtitle: "Expo push 以外のリモートアクティビティイベントを配信するには webhook を追加してください。",
      enabledTitle: "Webhook を有効化",
      enabledSubtitle: "Webhook 通知が有効です",
      disabledSubtitle: "Webhook 通知が無効です",
      channelEnabledSubtitle: "このエンドポイントがアクティビティ通知を受信できるようにします",
      urlPromptTitle: "Webhook の URL",
      urlPromptSubtitle: "この通知 webhook の送信先 URL を入力してください。",
      urlPromptPlaceholder: "https://hooks.example.test/notify",
      invalidUrlTitle: "無効な webhook URL",
            invalidUrlSubtitle: "有効な HTTP または HTTPS URL を入力してください。",
            deleteTitle: "Webhook を削除",
            deleteConfirm: ({ url }: { url: string }) => `${url} への通知送信を停止しますか？`,
            signingSecretTitle: "署名シークレット",
            signingSecretEmptySubtitle: "Webhook ペイロードに署名する共有シークレットを追加します",
            signingSecretConfiguredSubtitle: "Webhook ペイロードは共有シークレットで署名されます",
            signingSecretPromptTitle: "Webhook 署名シークレット",
            signingSecretPromptSubtitleAdd: "この webhook ペイロードに署名する共有シークレットを入力してください。",
            signingSecretPromptSubtitleReplace: "既存の署名シークレットを置き換える新しい共有シークレットを入力してください。",
            signingSecretPromptPlaceholder: "shared-secret",
            signingSecretClearAction: "シークレットを消去",
            readyTitle: "準備完了",
      readySubtitle: "ターンが終了し、エージェントがコマンドを待っているときに送信します",
      readyPreviewTitle: "準備完了メッセージのプレビュー",
      readyPreviewSubtitle: "この webhook の準備完了通知に最新のアシスタントメッセージを含めます",
      permissionRequestsTitle: "権限リクエスト",
      permissionRequestsSubtitle: "セッションが承認待ちでブロックされているときに送信します",
      userActionsTitle: "操作リクエスト",
      userActionsSubtitle: "セッションが回答または確認を必要とするときに送信します",
    },
    foregroundBehavior: {
      title: "アプリ内通知",
      footer:
        "アプリ使用中の通知を制御します。現在表示中のセッションの通知は常にミュートされます。",
      full: "フル",
      fullDescription: "バナーを表示してサウンドを再生",
      silent: "サイレント",
      silentDescription: "サウンドなしでバナーを表示",
      off: "オフ",
      offDescription: "バッジのみ、バナーなし",

      account: "アカウント既定",
      accountDescription:
        "このデバイスでアカウントのアプリ内通知動作を使用します",},
    types: {
      title: "種類",
      footer: "必要な通知だけ受け取りたい場合は種類ごとに無効化できます。",
      ready: {
        title: "準備完了",
        subtitle:
          "ターンが完了し、エージェントがあなたのコマンドを待っているときに通知します",
      },
      readyPreview: {
        title: "準備完了メッセージのプレビュー",
        subtitle: "準備完了ターンのプッシュ通知に最新のアシスタントメッセージ本文を含めます",
      },
      permissionRequests: {
        title: "権限リクエスト",
        subtitle:
          "セッションが承認待ちでブロックされているときに通知します",
      },
      userActions: {
        title: "操作リクエスト",
        subtitle:
          "セッションが回答や確認を必要とするときに通知します",
      },
    },

    activitySurfaces: {
      title: "アクティビティ表示",
      footer: "このデバイスの Live Activities、Dynamic Island、ウィジェットを制御します。",
      enabledSubtitle: "このデバイスでセッション表示を有効化",
      shared: {
        title: "共通の動作",
        footer: "すべてのアクティビティ表示で、タップとプレビューの挙動を選択します。",
      },
      tapTargetTitle: "タップ先",
      tapTargetOpenSessionTitle: "現在のセッションを開く",
      tapTargetOpenSessionsTitle: "アクティブなセッションを開く",
      privacyTitle: "プライバシー",
      privacyStatusOnlyTitle: "ステータスのみ",
      privacyTitleOnlyTitle: "タイトルのみ",
      privacyIncludePreviewTitle: "プレビュー文字列を含める",
      liveActivities: {
        title: "Live Activities",
        footer: "iPhone のロック画面と Dynamic Island の表示を制御します。",
        enabledSubtitle: "このデバイスで Live Activities を有効化",
        strategyTitle: 'Activity strategy',
        strategySubtitle: '1つのアクティビティを最重要のセッションに追従させるか、固定するかを選びます。',
        presentationTitle: '表示モード',
        presentationSubtitle: 'Live Activities が現在のセッションをどのように強調するかを選びます。',
        focusedTitle: "フォーカスしたセッション",
        attentionTitle: "注意",
        runningTitle: "実行中のセッション",
        dynamicPrimaryTitle: 'Dynamic primary',
        pinnedPrimaryTitle: 'Pinned primary',
        sessionSpecificTitle: 'Session specific',
        maxConcurrentTitle: "同時表示数の上限",
        maxConcurrentOneTitle: "1 件",
        maxConcurrentTwoTitle: "2 件",
        maxConcurrentFourTitle: "4 件",
        previewTextTitle: "プレビュー文字列",
        actionButtonsTitle: "アクションボタン",
        includeReadyTitle: "準備完了セッションを含める",
        includeThinkingTitle: "思考中セッションを含める",
        remoteUpdates: {
          title: "リモート更新",
          footer: "アプリが前面でなくなった後に Live Activities を更新するための選択中サーバー診断です。",
          effectiveModeTitle: "有効な配信",
          effectiveMode: {
            hosted_happier_relay: "ホスト型リレー",
            direct_apns: "直接 APNs",
            background_wake_best_effort: "バックグラウンド起動",
            local_only: "ローカルランタイムのみ",
            disabled: "無効",
          },
          details: {
            available: "利用可能",
            unavailable: "利用不可",
            blocked: "ブロック済み",
            missingCredentials: "認証情報が不足",
            bestEffort: "ベストエフォート",
            selected: "選択中",
            fallback: "フォールバック",
            preferred_unavailable: "ローカルのみ",
            local_only: "ローカルのみ",
            disabled: "無効",
            runtimeOnly: "ランタイムのみ",
          },
          hostedRelayTitle: "ホスト型 Happier リレー",
          hostedRelayAvailableSubtitle: "ホスト型リレーはこの選択中サーバーに設定されています。",
          hostedRelayDisabledSubtitle: "ホスト型リレーはこの self-hosted サーバーで無効です。",
          hostedRelayBlockedSubtitle: "ホスト型リレーの ID とプロバイダー対応はまだ実装されていません。",
          hostedRelayUnavailableSubtitle: "ホスト型リレーはこの選択中サーバーから利用できません。",
          directApnsTitle: "直接 APNs",
          directApnsConfiguredSubtitle: "直接 APNs の認証情報は、秘密情報を露出せずに設定されています。",
          directApnsMissingCredentialsSubtitle: "直接 APNs にはサーバー側の認証情報設定が不足しています。",
          directApnsUnavailableSubtitle: "直接 APNs はこの選択中サーバーでは利用できません。",
          backgroundWakeTitle: "バックグラウンド起動",
          backgroundWakeBestEffortSubtitle: "バックグラウンド起動は更新を試行できますが、iOS が遅延または破棄する場合があります。",
          backgroundWakeDisabledSubtitle: "バックグラウンド起動フォールバックはこの選択中サーバーで無効です。",
          localOnlyTitle: "ローカルのみの更新",
          localOnlyRuntimeSubtitle: "ローカルのみの更新はアプリのランタイムが実行できる間だけ動作します。アプリ終了後の更新は保証しません。",
        },
      },
      widgets: {
        title: "ホーム画面ウィジェット",
        footer: "デバイスのホーム画面に表示されるウィジェット概要を制御します。",
        enabledSubtitle: "このデバイスでウィジェットを有効化",
        summaryTitle: "概要",
        attentionTitle: "注意",
        runningTitle: "実行中のセッション",
        previewTextTitle: "プレビュー文字列",
        machinePathTitle: "マシンとパス",
      },
    },
    quietHours: {
      title: "静かな時間",
      footer: "アカウントの静かな時間は既定ですべての場所に適用されます。デバイスの上書きはこのデバイスにのみ影響します。",
      accountOffTitle: "アカウントの静かな時間なし",
      accountOffSubtitle: "アカウント通知をいつでも配信します",
      accountNightlyTitle: "毎晩 22:00 から 7:00",
      accountNightlySubtitle: "夜間は注意チャンネルを消音または抑制します",
      deviceAccountTitle: "このデバイスはアカウント時間に従います",
      deviceAccountSubtitle: "同期されたアカウントの静かな時間ポリシーを使用します",
      deviceDisabledTitle: "このデバイスで静かな時間を無効化",
      deviceDisabledSubtitle: "アカウントの静かな時間が有効でも、このデバイスでは配信できます",
      deviceCustomNightlyTitle: "このデバイスは夜間の静かな時間を使用します",
      deviceCustomNightlySubtitle: "このデバイスでアカウント時間を 22:00 から 7:00 に上書きします",
    },
    sounds: {
      title: "サウンド",
      footer: "アカウントの既定サウンドはすべての場所で同期されます。このデバイスではローカルサウンドを消音できます。",
      accountHappierTitle: "Happier サウンド",
      accountHappierSubtitle: "更新には柔らかい音、注意が必要なときには明るい音を使います",
      accountDefaultTitle: "システム既定",
      accountDefaultSubtitle: "プラットフォームの通知音を使用します",
      accountSilentTitle: "サイレント",
      accountSilentSubtitle: "音なしで通知を配信します",
      deviceEnabledTitle: "このデバイスでサウンドを再生",
      deviceEnabledSubtitle: "ローカル通知サウンドのデバイス上書き",
      previewTitle: "サウンドをプレビュー",
      previewSubtitle: "このデバイスにローカルのプレビュー通知を送信します",
      previewNotificationTitle: "通知サウンドのプレビュー",
      previewNotificationBody: "現在の通知サウンドはこのように動作します。",
    },},

  notifications: {
    actions: {
      allow: "許可",
      deny: "拒否",
      answer: "回答",

      other: "その他",
      alwaysAllowTool: ({ tool }: { tool: string }) => `${tool} を常に許可`,},
    activity: {
      defaultSessionTitle: "セッション",
      readyFallbackBody: "ターンが終了しました。続行するにはセッションを開いてください。",
      permissionFallbackBody: "承認が必要です。",
      userActionFallbackBody: "このセッションには入力が必要です。",
    },
    channels: {
      default: "デフォルト",
      permissionRequests: "権限リクエスト",
      userActionRequests: "操作リクエスト",
    },
  },

  settingsProviders: settingsProvidersTranslations.ja,

  settingsAgents: {
      title: "AIプロバイダー設定",
      entrySubtitle: "プロバイダー固有のオプションを設定します",
      footer:
      "プロバイダー固有のオプションを設定します。これらの設定はセッションの動作に影響する場合があります。",
      configuration: '設定',
      cliConnection: 'CLI 接続',
      capabilities: '機能',
      models: 'モデル',
      providerSubtitle: "プロバイダー固有の設定",
      stateEnabled: "有効",
      stateDisabled: "無効",
      channelStable: "安定版",
      channelExperimental: "実験版",
      channelPlugin: "プラグイン",
      supported: "対応",
      notSupported: "未対応",
      allowed: "許可",
      notAllowed: "不許可",
      notAvailable: "利用不可",
      enabledTitle: "有効",
      enabledSubtitle: "ピッカー、プロファイル、セッションでこのバックエンドを使用",
      releaseChannelTitle: "リリースチャネル",
      capabilitiesTitle: "機能",
      resumeSupportTitle: "再開サポート",
      sessionModeSupportTitle: "セッションモード対応",
      runtimeModeSwitchingTitle: "実行時モード切り替え",
      localControlTitle: "ローカル制御",
      resumeSupportSupported: "対応",
      resumeSupportSupportedExperimental: "対応（実験）",
      resumeSupportNotSupported: "未対応",
      sessionModeNone: "ACP モードなし",
      sessionModeAcpPolicyPresets: "ACP ポリシープリセット",
      sessionModeAcpAgentModes: "ACP エージェントモード",
      sessionModeDynamicPolicyModes: "動的ポリシーモード",
      sessionModeDynamicAgentModes: "動的エージェントモード",
      sessionModeStaticAgentModes: "静的エージェントモード",
      runtimeSwitchNone: "実行時切り替えなし",
      runtimeSwitchMetadataGating: "メタデータによるゲート",
      runtimeSwitchAcpSetSessionMode: "ACP: setSessionMode",
      runtimeSwitchSessionModeApi: "セッションモード API",
      runtimeSwitchProviderNative: "プロバイダー固有",
      modelsTitle: "モデル",
      modelSelectionTitle: "モデル選択",
      freeformModelIdsTitle: "自由入力モデル ID",
      defaultModelTitle: "既定モデル",
      catalogModelListTitle: "カタログモデル一覧",
      catalogModelListEmpty: "利用可能なカタログモデルがありません",
      dynamicModelProbeTitle: "動的モデルプローブ",
      dynamicModelProbeAuto: "自動",
      dynamicModelProbeStaticOnly: "静的のみ",
      nonAcpApplyScopeTitle: "非 ACP モデル適用範囲",
      nonAcpApplyScopeSpawnOnly: "セッション開始時に適用",
      nonAcpApplyScopeNextPrompt: "次のメッセージで適用",
      acpApplyBehaviorTitle: "ACP モデル適用動作",
      acpApplyBehaviorSetModel: "ライブでモデルを設定",
      acpApplyBehaviorRestartSession: "セッションを再起動",
      acpConfigOptionTitle: "ACP モデル設定オプションID",
      cliConnectionTitle: "CLI と接続",
      targetMachineTitle: "対象マシン",
      detectedCliTitle: "検出された CLI",
      installSetupTitle: "インストール / セットアップ",
      installInfoSeeSetupGuide: "セットアップガイドを表示",
      installInfoUseAgentCliInstaller: "プロバイダーの CLI インストーラーを使用",
      setup: {
        selectionFooter: "1 つ以上のプロバイダーを選び、選択したマシンで 1 つずつ完了してください。",
        startTitle: "プロバイダーをセットアップ",
        startDescription: "選択したプロバイダーをキューに入れ、インストールとサインインを 1 つの標準フローで完了します。",
        queueTitle: "プロバイダー設定キュー",
        queueDescription: ({ provider }: { provider: string }) => `${provider} を完了してから、キュー内の次のプロバイダーに進みます。`,
        activeDescription: "設定キュー内の現在のプロバイダー",
        activeStatus: "進行中",
        completedStatus: "完了",
        skippedStatus: "スキップ",
        skipAction: "このプロバイダーをスキップ",
        completedTitle: "プロバイダー設定が完了しました",
        completedDescription: "選択したプロバイダーのキューの最後まで完了しました。",
      },
      cliSourcePreference: {
        title: "CLI ソースの優先順位",
        subtitle:
          "両方が存在する場合に、システムの CLI と Happier 管理インストールのどちらを優先するかを選択します。",
        options: {
          systemFirst: {
            title: "システムのインストールを優先",
            subtitle: "このマシンにすでにインストールされている CLI を優先します。",
          },
          managedFirst: {
            title: "管理インストールを優先",
            subtitle: "このプロバイダー用に Happier がインストールした CLI を優先します。",
          },
        },
      },
      cliInstaller: {
        installTitle: ({ provider }: { provider: string }) => `${provider} CLI をインストール`,
        reinstallTitle: ({ provider }: { provider: string }) => `${provider} CLI を再インストール`,
        autoInstallUnavailable: "このマシンでは自動インストールを利用できません。",
        installSubtitle:
          "選択したマシンにプロバイダー CLI をインストールします（ベストエフォート）。",
        reinstallSubtitle:
          "CLI が既に存在する場合でも、プロバイダーのインストーラーを再実行します。",
        confirmInstallTitle: ({ provider }: { provider: string }) => `${provider} CLI をインストールしますか？`,
        confirmReinstallTitle: ({ provider }: { provider: string }) => `${provider} CLI を再インストールしますか？`,
        confirmBody: ({ provider }: { provider: string }) =>
          `選択したマシンで ${provider} のインストーラー コマンドを実行します。プロバイダーを信頼できる場合のみ続行してください。`,
        confirmInstallConfirm: "インストール",
        confirmReinstallConfirm: "再インストール",
        noMachineSelected: "マシンが選択されていません。",
        installNotSupported: "このマシンではインストールに対応していません。",
        installFailed: "インストールに失敗しました。",
        installed: "インストール済み。",
        logPath: ({ logPath }: { logPath: string }) => `ログ: ${logPath}`,
      },
      setupGuideUrlTitle: "セットアップガイド URL",
      authentication: {
        title: "認証",
        footer: "ローカル CLI の認証状態を確認し、対応している場合はサインインを開始します。",
        terminalTitle: "プロバイダー ログイン端末",
        logInTitle: "ログイン",
        logInSubtitle: "このマシンでターミナルを開き、プロバイダーのサインインを実行します。",
        reauthenticateTitle: "再認証",
        reauthenticateSubtitle: "このマシンでターミナルを開き、プロバイダーのサインインを更新します。",
        checkNowTitle: "今すぐ確認",
        checkNowSubtitle: "検出されたローカル認証状態を更新します。",
        statusTitle: "状態",
        loggedInAsTitle: "ログイン中のアカウント",
        methodTitle: "認証方法",
        sourceTitle: "認証情報の取得元",
        reasonTitle: "問題",
        lastCheckedTitle: "最終確認",
        stateUnknown: "不明",
        stateLoggedIn: "ログイン済み",
        stateLoggedOut: "ログアウト済み",
        methods: {
          apiKeyEnv: "API キー環境変数",
          authTokenEnv: "認証トークン環境変数",
          credentialsFile: "認証情報ファイル",
          oauthCli: "CLI OAuth ログイン",
          configFile: "設定ファイル",
          gcloudAdc: "Google Cloud アプリケーションのデフォルト認証情報",
          unknown: "不明",
        },
        reasons: {
          missingCredentials: "認証情報がありません",
          expired: "認証情報の有効期限が切れています",
          cliMissing: "CLI がインストールされていません",
          probeFailed: "状態確認に失敗しました",
          timeout: "状態確認がタイムアウトしました",
          unsupported: "ローカル認証はサポートされていません",
          interactiveBlocked: "対話型ログインはブロックされています",
          notConfigured: "未設定",
        },
        sources: {
          environment: "環境",
          file: "ファイル",
          command: "コマンド",
          mixed: "混在",
        },
      },
      connectedServiceTitle: "接続済みサービス",
      notFoundTitle: "プロバイダーが見つかりません",
    notFoundSubtitle: "このプロバイダーには設定画面がありません。",
    noOptionsAvailable: "利用可能なオプションはありません",
    invalidNumber: "無効な数値です",
    invalidJson: "無効なJSONです",
    plugins: {
            claude: {
                title: "Claude（リモート）",
                sections: {
                    claudeCodeExperiments: {
                        title: "Claude Code の実験機能",
                        footer: "これらの設定は、Happier から開始する Claude のローカル（ターミナル）およびリモート（Agent SDK）セッションの両方に適用されます。"
                    },
                    claudeUnifiedTerminal: {
                        title: "Claude 統合ターミナル",
                        footer: "Claude Code をターミナルホスト上のセッションとして実行し、対応する Happier プロンプトをターミナルホスト経由で届けます。"
                    },
                    claudeRemoteSdk: {
                        title: "Claude Agent SDK（リモートモード）",
                        footer: "リモートモードでは Claude をあなたのマシンで実行しつつ、Happier UI から操作します。ローカルモードはターミナル上の Claude Code TUI です。これらの設定はリモートモードにのみ適用されます。"
                    }
                },
                fields: {
                    claudeCodeExperimentalAgentTeamsEnabled: {
                        title: "Agent Teams を強制的に有効化",
                        subtitle: "Happier から開始するすべての Claude セッションで、Claude Code の実験的 Agent Teams（エージェント群）を有効にします。"
                    },
                    claudeUnifiedTerminalEnabled: {
                        title: "統合ターミナルモードを使用",
                        subtitle: "Claude Code を正規のターミナルセッションとして維持し、対応する Happier プロンプトをそのセッションへ送信します。"
                    },
                    claudeUnifiedTerminalHost: {
                        title: "ターミナルホスト",
                        subtitle: "統合 Claude セッションで Happier が使うターミナルマルチプレクサを選択します。",
                        options: {
                            auto: {
                                title: "自動",
                                subtitle: "このマシンで最も適した対応ホストを優先します。"
                            },
                            tmux: {
                                title: "tmux",
                                subtitle: "利用可能な場合は tmux を使用します。"
                            },
                            zellij: {
                                title: 'zellij',
                                subtitle: "利用可能で対応している場合は Zellij を使用します。"
                            }
                        }
                    },
                    claudeUnifiedTerminalResumeChoice: {
                        title: "大規模セッションの再開",
                        subtitle: "大きなセッションの再開方法を Claude が尋ねたときの Happier の応答を選択します。",
                        options: {
                            ask_every_time: {
                                title: "毎回確認",
                                subtitle: "Claude が尋ねるたびにセッション内にユーザーアクションを表示します。"
                            },
                            resume_from_summary: {
                                title: "要約から再開",
                                subtitle: "Claude の要約を使って大きなセッションをより速く再開します。"
                            },
                            resume_full_session: {
                                title: "セッション全体を再開",
                                subtitle: "Claude が選択肢を提示したときにセッション全体のコンテキストを読み込みます。"
                            }
                        }
                    },
                    claudeUnifiedTerminalWorkspaceTrust: {
                        title: "Workspace trust",
                        subtitle: "Choose how Happier responds when Claude asks whether to trust a workspace.",
                        options: {
                            ask_every_time: {
                                title: "Ask every time",
                                subtitle: "Show the exact workspace trust question in the session."
                            },
                            always_trust_happier_workspaces: {
                                title: "Always trust Happier workspaces",
                                subtitle: "Trust the current recaptured Claude prompt for workspaces opened by Happier."
                            },
                            always_reject_happier_workspaces: {
                                title: "Always reject Happier workspaces",
                                subtitle: "Reject the current recaptured Claude prompt for workspaces opened by Happier."
                            }
                        }
                    },
                    claudeRemoteAgentSdkEnabled: {
                        title: "Agent SDK を使用（リモート）",
                        subtitle: "リモートモードで公式の @anthropic-ai/claude-agent-sdk を使用します。"
                    },
                    claudeRemoteDebugEnabled: {
                        title: "デバッグモード",
                        subtitle: "Claude Code のデバッグログを有効にします（--debug と同等）。"
                    },
                    claudeRemoteVerboseEnabled: {
                        title: "詳細",
                        subtitle: "詳細ログを有効にします（--verbose と同等）。"
                    },
                    claudeRemoteDebugCategories: {
                        title: "デバッグカテゴリ",
                        subtitle: "任意のカテゴリフィルタ。空の場合はすべてのデバッグカテゴリを出力します。",
                        options: {
                            api: {
                                title: "API",
                                subtitle: "HTTP/API リクエストとレスポンス。"
                            },
                            mcp: {
                                title: "MCP",
                                subtitle: "MCP サーバー接続とツール通信。"
                            },
                            hooks: {
                                title: "Hooks",
                                subtitle: "フックのライフサイクルとコマンド実行。"
                            },
                            file: {
                                title: "ファイル",
                                subtitle: "ファイル操作とファイル関連ヘルパー。"
                            },
                            '1p': {
                                title: "1p",
                                subtitle: "ファーストパーティ内部カテゴリ。"
                            }
                        }
                    },
                    claudeRemoteSettingSourcesV2: {
                        title: "設定ソース",
                        subtitle: "どの Claude 設定を読み込むかを制御します。",
                        options: {
                            user: {
                                title: "ユーザー",
                                subtitle: "Claude のユーザー全体設定を読み込みます。"
                            },
                            project: {
                                title: "プロジェクト",
                                subtitle: "リポジトリ設定（CLAUDE.md を含む）を読み込みます。"
                            },
                            local: {
                                title: "ローカル",
                                subtitle: "ローカル専用の上書きを読み込みます。"
                            }
                        }
                    },
                    claudeLocalPermissionBridgeEnabled: {
                        title: "実験的: ローカル権限ブリッジ",
                        subtitle: "Claude のローカルモード権限プロンプトを Happier に転送し、UI から承認または拒否できるようにします。"
                    },
                    claudeLocalPermissionBridgeWaitIndefinitely: {
                        title: "応答があるまで要求を開いたままにする",
                        subtitle: "有効にすると、Happier は UI から承認または拒否するまで Claude のローカル権限要求を保留のまま維持します。"
                    },
                    claudeLocalPermissionBridgeTimeoutSeconds: {
                        title: "任意の権限タイムアウト（秒）",
                        subtitle: "無期限待機をオフにした場合にのみ使用されます。この時間を過ぎると、Happier は Claude のターミナルプロンプトにフォールバックします。"
                    },
                    claudeRemoteEnableFileCheckpointing: {
                        title: "ファイルチェックポイント + /rewind",
                        subtitle: "ファイルチェックポイントと /rewind を有効にします（ファイルのみ。会話は巻き戻しません）。一覧は /checkpoints、適用は /rewind --confirm を使います（オーバーヘッド増）。"
                    },
                    claudeRemoteMaxThinkingTokens: {
                        title: "思考トークン上限",
                        subtitle: "Claude の内部思考予算を制限します（null = 既定）。"
                    },
                    claudeRemoteDisableTodos: {
                        title: "TODO を無効化",
                        subtitle: "リモートモードで Claude が TODO 項目を作成しないようにします。"
                    },
                    claudeRemoteStrictMcpServerConfig: {
                        title: "厳格な MCP サーバー設定",
                        subtitle: "いずれかの MCP サーバー設定が無効な場合は失敗します。"
                    },
                    claudeRemoteAdvancedOptionsJson: {
                        title: "高度なオプション（JSON）",
                        subtitle: "上級者向けの Agent SDK 上書き設定です（クライアント側で検証）。"
                    }
                }
            },
            opencode: {
                title: "OpenCode",
                sections: {
                    backendMode: {
                        title: "バックエンドモード",
                        footer: "サーバーモードでは質問機能とネイティブフォークが使えます。ACP モードはレガシーなフォールバックです。"
                    },
                    server: {
                        title: "サーバー接続",
                        footer: "空のままにすると、Happier 管理の OpenCode サーバーライフサイクルを使います。自分で運用している任意のサーバーに接続するには絶対 HTTPS URL を設定し、HTTP は localhost にのみ使用できます。パスワードは URL ではなく下のフィールドに入力してください。"
                    }
                },
                fields: {
                    opencodeBackendMode: {
                        title: "OpenCode バックエンドモード",
                        subtitle: "統合バックエンドを選択します。",
                        options: {
                            server: {
                                title: "サーバー（推奨）",
                                subtitle: "OpenCode サーバー API を使用し、より豊富な機能と高い信頼性を提供します。"
                            },
                            acp: {
                                title: "ACP（レガシー）",
                                subtitle: "OpenCode を ACP 経由で利用します。機能は少なめです。"
                            }
                        }
                    },
                    opencodeServerBaseUrl: {
                        title: "既存の OpenCode サーバー URL",
                        subtitle: "自分で運用しているサーバー向けの任意の上書きです。HTTPS は任意のホストを使用でき、HTTP は localhost に限定されます。"
                    },
                    opencodeServerPassword: {
                        title: "既存の OpenCode サーバーのパスワード",
                        subtitle: "OpenCode サーバーを OPENCODE_SERVER_PASSWORD 付きで実行している場合のみ設定してください。この端末に暗号化して保存され、同期されることはありません。"
                    }
                }
            },
            auggie: {
                title: "Auggie"
            },
            copilot: {
                title: "Copilot"
            },
            customAcp: {
                title: "カスタム ACP"
            },
            gemini: {
                title: "Gemini"
            },
            kilo: {
                title: "Kilo"
            },
            kimi: {
                title: "Kimi",
                sections: {
                    compatibility: {
                        title: '互換性',
                        footer: 'Kimi ACP の起動が停止する Linux/コンテナ環境でのみ互換モードを使用してください。'
                    }
                },
                fields: {
                    kimiAcpPythonSelector: {
                        title: 'Python stdio セレクター',
                        subtitle: 'Happier が Kimi ACP の Python stdio ループを起動する方法を選択します。',
                        options: {
                            auto: {
                                title: '自動',
                                subtitle: 'Kimi のデフォルト Python セレクターを使用します。'
                            },
                            poll: {
                                title: '互換モード',
                                subtitle: 'Kimi ACP stdio に epoll() ではなく poll() を使用します。'
                            }
                        }
                    }
                }
            },
            kiro: {
                title: "Kiro"
            },
            pi: {
                title: "Pi"
            },
            qwen: {
                title: "Qwen Code"
            },
            antigravity: {
                title: "Antigravity",
                sections: {
                    runtime: {
                        title: "ランタイム",
                        footer: "Antigravity セッションの開始方法を選択します。CLI モードはサブスクリプションのログインを使い、ライブ制御は制限されます。SDK モードは Gemini API または Vertex 認証情報を使います。"
                    }
                },
                fields: {
                    antigravityRuntimeMode: {
                        title: "ランタイムモード",
                        subtitle: "自動ルーティング、サブスクリプション CLI print モード、または SDK モードを選択します。",
                        options: {
                            auto: {
                                title: "自動",
                                subtitle: "利用可能な場合はサブスクリプション CLI を優先し、その後 SDK 認証情報を使います。"
                            },
                            cliPrint: {
                                title: "Antigravity CLI（サブスクリプション）",
                                subtitle: "ローカルログインで agy print モードを使います。ライブのツール承認は制限されます。"
                            },
                            sdk: {
                                title: "Antigravity SDK（Gemini API / Vertex）",
                                subtitle: "SDK 経由で Gemini API キーまたは Vertex 認証情報を使います。"
                            }
                        }
                    }
                }
            },
            codex: {
        title: "Codex",
        sections: {
          backendMode: {
            title: "ルーティングモード",
            footer:
              "Codex のルーティング方法を選択します。推奨される既定はアプリサーバーです。ローカル/リモート切り替えと再開はアプリサーバーで利用でき、ACP は引き続きレガシーなフォールバックとして使えます。",
          },
          installOverrides: {
            title: "インストール元の上書き",
            footer: "任意。空欄のままにすると既定のインストール元を使用します。",
          },
        },
        fields: {
          codexBackendMode: {
            title: "Codex ルーティングモード",
            subtitle: "アプリサーバー、ACP、または MCP を選択します。",
            options: {
              appServer: {
                title: "アプリサーバー",
                subtitle: "推奨される公式 Codex アプリサーバーモード",
              },
              acp: {
                title: "ACP",
                subtitle: "ACP 経由で Codex をルーティング (codex-acp)",
              },
              mcp: {
                title: "MCP",
                subtitle: "既定の Codex MCP モード",
              },
            },
          },
        },
      },
    },
  },

  workspaceCockpit: {
    openCockpit: 'コックピットを開く',
    openClassicView: 'クラシック表示を開く',
    tabs: 'タブ',
  },

  settingsAppearance: {
    tabBarAppearance: {
      title: 'タブバー',
      footer: '下部のタブバーをカスタマイズします。',
      showLabels: 'タブのラベルを表示',
      size: 'タブバーのサイズ',
      sizeCompact: 'コンパクト',
      sizeRegular: '標準',
      sizeLarge: '大',
    },
    glass: {
      title: 'ガラスサーフェス',
      footer: 'フローティングのガラスサーフェス（タブバー、最下部へ移動ボタンなど）に半透明のぼかしマテリアルを使用します。',
      enable: 'ガラスのぼかし',
      intensity: 'ぼかしの強さ',
      intensityLight: '弱',
      intensityRegular: '標準',
      intensityStrong: '強',
      composer: 'ガラス入力欄',
      composerHint: 'タブバーに合わせる — メッセージ入力欄にタブバーのサーフェスカラーと影を適用します。',
    },
    tabBarBadges: {
      title: 'タブバーのバッジ',
      footer: '下部のタブバーに表示するバッジを選択します。',
      gitTitle: 'Git タブのバッジ',
      gitChangedFiles: '変更されたファイル',
      gitDiffLines: '追加・削除された行',
      gitOff: 'オフ',
    },
    ...settingsAppearanceTranslationExtension,
    // Appearance settings screen
    theme: "テーマ",
    themeDescription: "お好みの配色を選択",
    themeOptions: {
      adaptive: "自動",
      light: "ライト",
      dark: "ダーク",
    },
    themeDescriptions: {
      adaptive: "システム設定に合わせる",
      light: "常にライトテーマを使用",
      dark: "常にダークテーマを使用",
    },
    display: "表示",
    displayDescription: "レイアウトと間隔を調整",
    contentWidth: "コンテンツ幅",
    contentWidthDescription: "メインコンテンツの最大幅を選択します",
    contentWidthOptions: {
      compact: "コンパクト",
      compactDescription: "メインコンテンツを850 pxまでに制限します",
      medium: "中",
      mediumDescription: "メインコンテンツを960 pxまで許可します",
      full: "全幅",
      fullDescription: "利用可能なウィンドウ幅を使用します",
    },
    backdropBlur: "背景ぼかし",
    backdropBlurDescription:
      "モーダルやメニューの背後に背景ぼかしを適用します。ブラウザー性能を優先する場合は無効にしてください。",
    multiPanePanels: "右パネル",
    multiPanePanelsDescription:
      "ファイルとソース管理のための右側パネルを表示（Web/タブレット）",
    sessionsRightPaneDefaultOpen: "セッションで右サイドバーを常に表示",
    sessionsRightPaneDefaultOpenDescription:
      "セッションを開くと右サイドバーを自動的に開きます（Web/タブレット）",
    detailsPaneTabsBehavior: "エディタのタブ",
    detailsPaneTabsBehaviorDescription:
      "エディタパネル内のファイルタブの挙動を選択します",
    detailsPaneTabsBehaviorOptions: {
      preview: "プレビュータブ",
      persistent: "固定タブ",
    },
    inlineToolCalls: "ツール呼び出しをインライン表示",
    inlineToolCallsDescription:
      "チャットメッセージ内にツール呼び出しを直接表示",
    expandTodoLists: "Todoリストを展開",
    expandTodoListsDescription: "変更点だけでなくすべてのTodoを表示",
    showLineNumbersInDiffs: "差分に行番号を表示",
    showLineNumbersInDiffsDescription: "コード差分に行番号を表示",
    showLineNumbersInToolViews: "ツールビューに行番号を表示",
    showLineNumbersInToolViewsDescription: "ツールビューの差分に行番号を表示",
    wrapLinesInDiffs: "差分で行を折り返し",
    wrapLinesInDiffsDescription:
      "差分表示で水平スクロールの代わりに長い行を折り返す",
    alwaysShowContextSize: "常にコンテキストサイズを表示",
    alwaysShowContextSizeDescription:
      "上限に近づいていなくてもコンテキスト使用量を表示",
    agentInputActionBarLayout: "入力アクションバー",
    agentInputActionBarLayoutDescription:
      "入力欄の上に表示するアクションチップの表示方法を選択します",
    agentInputActionBarLayoutOptions: {
      auto: "自動",
      wrap: "折り返し",
      scroll: "スクロール",
      collapsed: "折りたたみ",
    },
    agentInputChipDensity: "アクションチップ密度",
    agentInputChipDensityDescription:
      "アクションチップをラベル表示にするかアイコン表示にするか選択します",
    agentInputChipDensityOptions: {
      auto: "自動",
      labels: "ラベル",
      icons: "アイコンのみ",
    },
    avatarStyle: "アバタースタイル",
    avatarStyleDescription: "セッションアバターの外観を選択",
    avatarOptions: {
      pixelated: "ピクセル",
      gradient: "グラデーション",
      brutalist: "ブルータリスト",
      meshGradient: "メッシュグラデーション",
      meshGradientOrganic: "メッシュグラデーション: オーガニック",
      meshGradientRows: "メッシュグラデーション: 行",
      meshGradientColumns: "メッシュグラデーション: 列",
      meshGradientDiagonal: "メッシュグラデーション: 斜め",
      meshGradientOval: "メッシュグラデーション: 楕円",
      meshGradientWaves: "メッシュグラデーション: 波",
      meshGradientSoftNoise: "メッシュグラデーション: ソフトノイズ",
      photoGradient: "レイヤーグラデーション",
      photoGradientRows: "レイヤーグラデーション: 行",
      photoGradientColumns: "レイヤーグラデーション: 列",
      photoGradientDiagonal: "レイヤーグラデーション: 斜め",
      photoGradientWaves: "レイヤーグラデーション: 波",
      photoGradientOval: "レイヤーグラデーション: 楕円",
      photoGradientValueNoise: "レイヤーグラデーション: ソフトノイズ",
      photoGradientVoronoi: "レイヤーグラデーション: セル",
      photoGradientMeshGrid: "レイヤーグラデーション: グリッド",
    },
    showFlavorIcons: "AIプロバイダーアイコンを表示",
    showFlavorIconsDescription:
      "セッションアバターにAIプロバイダーアイコンを表示",
    compactSessionView: "コンパクトセッション表示",
    compactSessionViewDescription:
      "アクティブなセッションをコンパクトなレイアウトで表示",
    compactSessionViewMinimal: "最小コンパクト表示",
    compactSessionViewMinimalDescription:
      "最も細いセッション行レイアウトを使用",
    text: "テキスト",
    textDescription: "アプリ全体の文字サイズを調整します",
    textSize: "文字サイズ",
    textSizeDescription: "文字を大きくしたり小さくしたりします",
    textSizeOptions: {
      xxsmall: "超極小",
      xsmall: "極小",
      small: "小",
      default: "標準",
      large: "大",
      xlarge: "特大",
      xxlarge: "超特大",
    },
    itemDensity: "項目密度",
    itemDensityDescription: "アプリ全体でリスト行や設定項目の大きさを選択します",
    itemDensityOptions: {
      comfortable: "標準",
      comfortableDescription: "標準の行サイズと余白を使います",
      cozy: "中間",
      cozyDescription: "コンパクト表示ほど詰めずに、少しだけ密度を上げます",
      compact: "コンパクト",
      compactDescription: "余白を詰めて画面により多くの行を表示します",
    },

    settingsNavSidebar: "設定サイドバー",
    settingsNavSidebarDescription:
      "設定ナビゲーションのサイドバーを表示（Web/タブレット）",},

  settingsFeatures: {
    // Features settings screen
    experiments: "実験的機能",
    experimentsDescription:
      "開発中の実験的機能を有効にします。これらの機能は不安定であったり、予告なく変更される場合があります。",
    experimentalFeatures: "実験的機能",
    experimentalFeaturesEnabled: "実験的機能が有効です",
    experimentalFeaturesDisabled: "安定版機能のみを使用",
    experimentalOptions: "実験オプション",
    experimentalOptionsDescription: "有効にする実験的機能を選択します。",
    localTogglesTitle: "機能",
    localTogglesFooter: "機能ごとのローカルトグル（サーバー対応とは独立）。",
    featureDiagnostics: {
      title: "機能診断",
      footer:
        "解決済みの機能判定（ビルドポリシー、ローカルポリシー、デーモン/サーバーのプローブ、スコープ）。",
      decisionUnknown: "不明",
      decisionEnabled: "有効",
      decisionBlocked: ({
        state,
        blockedBy,
        code,
      }: {
        state: string;
        blockedBy: string | null;
        code: string;
      }) => `${state}（blockedBy=${blockedBy ?? "null"}, code=${code}）`,
    },
    expAutomations: "オートメーション",
    expAutomationsSubtitle: "オートメーションのUIとスケジュール機能を有効化",
    expExecutionRuns: "実行ラン",
    expExecutionRunsSubtitle:
      "実行ラン（サブエージェント/レビュー）の制御プレーンUIを有効化",
    expAttachmentsUploads: "添付ファイルのアップロード",
    expAttachmentsUploadsSubtitle:
      "ファイル/画像のアップロードを有効にし、エージェントがディスクから読めるようにします",
    expUsageReporting: "使用状況レポート",
    expUsageReportingSubtitle: "使用量とトークンのレポート画面を有効化",
    expScmOperations: "バージョン管理操作",
    expScmOperationsSubtitle:
      "実験的なバージョン管理の書き込み操作（stage/commit/push/pull）を有効にします",
    expFilesReviewComments: "ファイルレビューコメント",
    expFilesReviewCommentsSubtitle:
      "ファイル/差分ビューから行単位のレビューコメントを追加し、構造化メッセージとして送信します",
    expFilesDiffSyntaxHighlighting: "差分の構文ハイライト",
    expFilesDiffSyntaxHighlightingSubtitle:
      "差分/コードビューで構文ハイライトを有効化（性能制限あり）",
    expFilesAdvancedSyntaxHighlighting: "高度な構文ハイライト",
    expFilesAdvancedSyntaxHighlightingSubtitle:
      "より重く高精度な構文ハイライトを使用（Webのみ、遅くなる場合あり）",
    expFilesEditor: "埋め込みファイルエディタ",
    expFilesEditorSubtitle:
      "ファイルブラウザから直接編集を有効化（Web/デスクトップはMonaco、ネイティブはCodeMirror）",
    expMarkdownRichEditor: 'リッチ Markdown エディタ',
    expMarkdownRichEditorSubtitle:
      'ファイルエディタで Markdown ファイル用のリッチ (WYSIWYG) エディタを有効化し、必要に応じてローにフォールバックします',
    expEmbeddedTerminal: "埋め込みターミナル",
    expEmbeddedTerminalSubtitle:
      "セッション内で本物のターミナルを開きます。",
    expSessionType: "セッションタイプ選択",
    expSessionTypeSubtitle:
      "セッションタイプ選択を表示（シンプル/ワークツリー）",
    expZen: "Zen",
    expZenSubtitle: "Zen のナビゲーション項目を有効化",
    expVoiceAuthFlow: "音声認証フロー",
    expVoiceAuthFlowSubtitle:
      "認証付きの音声トークンフローを使用（課金/制限対応）",
    voice: "音声",
    voiceSubtitle: "音声機能を有効化",
    expVoiceAgent: "音声エージェント",
    expVoiceAgentSubtitle:
      "デーモン連携の音声エージェントUIを有効化（実行ランが必要）",
    expVoiceDaemonInference: 'デーモン音声推論',
    expVoiceDaemonInferenceSubtitle: 'デーモンベースのローカル音声推論コントロールを有効にする',
    expLiveActivities: 'Live Activities',
    expLiveActivitiesSubtitle: 'セッション進行状況の Live Activities サーフェスを有効にする',
    expHomeScreenWidgets: 'ホーム画面ウィジェット',
    expHomeScreenWidgetsSubtitle: 'Happier アクティビティ用のホーム画面ウィジェットを有効にする',
    expConnectedServicesQuotas: "連携サービスのクォータ",
    expConnectedServicesQuotasSubtitle:
      "連携サービスのクォータバッジと使用量メーターを表示",
    expMemorySearch: "メモリ検索",
    expMemorySearchSubtitle: "ローカルメモリ検索の画面と設定を有効化",
    expSessionsDirect: "外部セッション",
    expSessionsDirectSubtitle: "既存のエージェントセッションを見つけてサイドバーにリンクする",
    expSessionsFolders: "セッションフォルダー",
    expSessionsFoldersSubtitle: "Happier サイドバーセッションをワークスペースのフォルダーで整理",
    expPetsCompanion: "ペット",
    expPetsCompanionSubtitle: "Blink コンパニオン画面とローカルペット選択を有効化",
    expFriends: "友だち",
    expFriendsSubtitle: "友だち機能（受信箱タブとセッション共有）を有効化",
    webFeatures: "Web機能",
    webFeaturesDescription: "Webバージョンでのみ利用可能な機能。",
    enterToSend: "Enterで送信",
    enterToSendEnabled: "Enterで送信（Shift+Enterで改行）",
    enterToSendDisabled: "Enterで改行",
    historyScope: "メッセージ履歴",
    historyScopePerSession: "履歴をセッションごとに切替",
    historyScopeGlobal: "履歴を全セッションで共有",
    historyScopeModalTitle: "メッセージ履歴",
    historyScopeModalMessage:
      "ArrowUp/ArrowDown で、このセッション内のみの送信履歴を巡回するか、全セッションの履歴を巡回するかを選択します。",
    historyScopePerSessionOption: "セッションごと",
    historyScopeGlobalOption: "グローバル",
      commandPalette: "コマンドパレット",
      commandPaletteEnabled: "ショートカットで開く",
      commandPaletteDisabled: "クイックコマンドアクセスは無効",
      hideInactiveSessions: "非アクティブセッションを非表示",
      hideInactiveSessionsSubtitle: "アクティブなチャットのみをリストに表示",
      hiddenInactiveSessionsEmptyStateTitle: "現在アクティブなセッションはありません",
      hiddenInactiveSessionsEmptyStateSubtitle: "非アクティブなセッションはこのリストで非表示になっています",
      hiddenInactiveSessionsSectionTitle: "非アクティブなセッション",
      hiddenInactiveSessionsSectionSubtitle: "メインの一覧ではアクティブなチャットだけが表示されるため、ここでは非表示になっています",
    sessionListActiveGrouping: "アクティブセッションのグループ化",
    sessionListActiveGroupingSubtitle:
      "サイドバーでアクティブセッションをどのようにグループ化するか選択します",
    sessionListInactiveGrouping: "非アクティブセッションのグループ化",
    sessionListInactiveGroupingSubtitle:
      "サイドバーで非アクティブセッションをどのようにグループ化するか選択します",
    sessionListGrouping: {
      projectTitle: "プロジェクト",
      projectSubtitle: "マシン + パスでセッションをグループ化",
      dateTitle: "日付",
      dateSubtitle: "最終アクティビティの日付でセッションをグループ化",
    },
    groupInactiveSessionsByProject:
      "非アクティブセッションをプロジェクト別にグループ化",
    groupInactiveSessionsByProjectSubtitle:
      "非アクティブなチャットをプロジェクトごとに整理",
    environmentBadge: "環境バッジ",
    environmentBadgeSubtitle:
      "Happier のタイトル横に現在のアプリ環境を示す小さなバッジを表示",
    enhancedSessionWizard: "拡張セッションウィザード",
    enhancedSessionWizardEnabled: "プロファイル優先セッションランチャーが有効",
    enhancedSessionWizardDisabled: "標準セッションランチャーを使用",
    profiles: "AIプロファイル",
    profilesEnabled: "プロファイル選択を有効化",
    profilesDisabled: "プロファイル選択を無効化",
    pickerSearch: "ピッカー検索",
    pickerSearchSubtitle: "マシンとパスのピッカーに検索欄を表示",
    machinePickerSearch: "マシン検索",
    machinePickerSearchSubtitle: "マシンピッカーに検索欄を表示",
    pathPickerSearch: "パス検索",
    pathPickerSearchSubtitle: "パスピッカーに検索欄を表示",
  },

  errors: {
    networkError: "ネットワークエラーが発生しました",
    serverError: "サーバーエラーが発生しました",
    unknownError: "不明なエラーが発生しました",
    connectionTimeout: "接続がタイムアウトしました",
    authenticationFailed: "認証に失敗しました",
    permissionDenied: "権限がありません",
    permissionDeniedReadOnlyMode: "読み取り専用モードにより拒否されました（書き込み操作は拒否されます）。",
    permissionCanceled: "権限がキャンセルされました",
    permissionCanceledSessionInactive: "セッションが非アクティブのため、この権限リクエストは承認できません。",
      fileNotFound: "ファイルが見つかりません",
      invalidFormat: "フォーマットが無効です",
      operationFailed: "操作に失敗しました",
      signupDisabled: "このサーバーでは新規アカウントの作成が無効になっています。既存のアカウントでサインインするか、サーバー管理者に登録の有効化を依頼してください。",
      failedToForkSession: "セッションの分岐に失敗しました",
      daemonUnavailableTitle: "デーモンを利用できません",
      daemonUnavailableBody:
        "このマシン上のデーモンに接続できません。オフライン、起動中、またはサーバーから切断されている可能性があります。",
      tryAgain: "再試行してください",
      contactSupport: "問題が続く場合はサポートにお問い合わせください",
      sessionNotFound: "セッションが見つかりません",
      voiceSessionFailed: "音声セッションの開始に失敗しました",
      dictationFailed: "音声入力に失敗しました",
      voiceServiceUnavailable: "音声サービスは一時的に利用できません",
      voiceSessionLimitStarted: ({ duration }: { duration: string }) =>
      `音声セッションの上限: 約${duration}です。`,
      voiceSessionLimitExpiring: ({ duration }: { duration: string }) =>
      `音声セッションは約${duration}後に終了します。`,
      voiceSessionLimitExpired:
      "音声セッションが現在の時間上限に達して終了しました。",
    voiceAlreadyStarting: "音声は別のセッションで起動中です",
    oauthInitializationFailed: "OAuth フローの初期化に失敗しました",
    tokenStorageFailed: "認証トークンの保存に失敗しました",
    oauthStateMismatch: "セキュリティ検証に失敗しました。再試行してください",
    providerAlreadyLinked: ({ provider }: { provider: string }) =>
      `${provider} は既存の Happier アカウントにすでにリンクされています。この端末でサインインするには、すでにサインイン済みの端末からこの端末をリンクしてください。`,
    tokenExchangeFailed: "認可コードの交換に失敗しました",
    oauthAuthorizationDenied: "認可が拒否されました",
    webViewLoadFailed: "認証ページの読み込みに失敗しました",
    failedToLoadProfile: "ユーザープロフィールの読み込みに失敗しました",
    userNotFound: "ユーザーが見つかりません",
    sessionDeleted: "セッションを利用できません",
    sessionDeletedDescription:
      "削除されたか、アクセス権がなくなった可能性があります。",

    // Error functions with context
    fieldError: ({ field, reason }: { field: string; reason: string }) =>
      `${field}: ${reason}`,
    validationError: ({
      field,
      min,
      max,
    }: {
      field: string;
      min: number;
      max: number;
    }) => `${field}は${min}から${max}の間である必要があります`,
    retryIn: ({ seconds }: { seconds: number }) => `${seconds}秒後に再試行`,
    errorWithCode: ({
      message,
      code,
    }: {
      message: string;
      code: number | string;
    }) => `${message} (エラー ${code})`,
    disconnectServiceFailed: ({ service }: { service: string }) =>
      `${service}の切断に失敗しました`,
    connectServiceFailed: ({ service }: { service: string }) =>
      `${service}の接続に失敗しました。再試行してください。`,
    failedToLoadFriends: "友達リストの読み込みに失敗しました",
    failedToAcceptRequest: "友達リクエストの承認に失敗しました",
    failedToRejectRequest: "友達リクエストの拒否に失敗しました",
    failedToRemoveFriend: "友達の削除に失敗しました",
    searchFailed: "検索に失敗しました。再試行してください。",
    failedToSendRequest: "友達リクエストの送信に失敗しました",
    failedToResumeSession: "セッションの再開に失敗しました",
    failedToSendMessage: "メッセージの送信に失敗しました",
    failedToSwitchControl: "制御モードの切り替えに失敗しました",
    cannotShareWithSelf: "自分自身とは共有できません",
    canOnlyShareWithFriends: "友達とのみ共有できます",
    shareNotFound: "共有が見つかりません",
    publicShareNotFound: "公開共有が見つからないか期限切れです",
    consentRequired: "アクセスには同意が必要です",
    maxUsesReached: "最大使用回数に達しました",
    invalidShareLink: "無効または期限切れの共有リンク",
    missingPermissionId: "権限リクエストIDがありません",
    codexResumeNotInstalledTitle:
      "このマシンには Codex 再開サーバーがインストールされていません",
    codexResumeNotInstalledMessage:
      "Codex の会話を再開するには、対象のマシンに Codex resume サーバーをインストールしてください（マシン詳細 → Installables）。",
    codexAcpNotInstalledTitle:
      "このマシンには Codex ACP がインストールされていません",
    codexAcpNotInstalledMessage:
      "Codex ACP の実験機能を使うには、対象のマシンに codex-acp をインストールしてください（マシン詳細 → Installables）。または実験機能を無効にしてください。",

    sourceControlUnavailableForSession: "Source control is unavailable for this session.",},

  deps: {
    installNotSupported:
      "この依存関係をインストールするには Happier CLI を更新してください。",
    installFailed: "インストールに失敗しました",
    installed: "インストールしました",
    installLog: ({ path }: { path: string }) => `インストールログ: ${path}`,
    installable: {
      codexResume: {
        title: "Codex 再開サーバー",
      },
      codexAcp: {
        title: "Codex ACP アダプター",
      },
      githubCli: {
        title: "GitHub コマンドライン",
      },

      gh: {
        title: "GitHub CLI",
      },},
    ui: {
      notAvailable: "利用できません",
      notAvailableUpdateCli: "利用できません（CLI を更新してください）",
      errorRefresh: "エラー（更新）",
      installed: "インストール済み",
      installedWithVersion: ({ version }: { version: string }) =>
        `インストール済み（v${version}）`,
      installedUpdateAvailable: ({
        installedVersion,
        latestVersion,
      }: {
        installedVersion: string;
        latestVersion: string;
      }) =>
        `インストール済み（v${installedVersion}）— 更新あり（v${latestVersion}）`,
      notInstalled: "未インストール",
      latest: "最新",
      latestSubtitle: ({ version, tag }: { version: string; tag: string }) =>
        `${version}（タグ: ${tag}）`,
      registryCheck: "レジストリ確認",
      registryCheckFailed: ({ error }: { error: string }) => `失敗: ${error}`,
      installSource: "インストール元",
      installSourceDefault: "（既定）",
      lastInstallLog: "前回のインストールログ",
      installLogTitle: "インストールログ",
    },
  },

  newSession: {
    ...newSessionMcpTranslationExtension,
    ...acpCatalogTranslationExtension.newSession,
    // Used by new-session screen and launch flows
    title: "新しいセッションを開始",
    selectAiProfileTitle: "AIプロファイルを選択",
    selectAiProfileDescription:
      "環境変数とデフォルト設定をセッションに適用するため、AIプロファイルを選択してください。",
    changeProfile: "プロファイルを変更",
    aiBackendSelectedByProfile:
      "AIバックエンドはプロファイルで選択されています。変更するには別のプロファイルを選択してください。",
    selectAiBackendTitle: "AIバックエンドを選択",
    aiBackendLimitedByProfileAndMachineClis:
      "選択したプロファイルと、このマシンで利用可能なCLIによって制限されます。",
    aiBackendSelectWhichAiRuns: "セッションで実行するAIを選択してください。",
    aiBackendNotCompatibleWithSelectedProfile:
      "選択したプロファイルと互換性がありません。",
    aiBackendCliNotDetectedOnMachine: ({ cli }: { cli: string }) =>
      `このマシンで${cli} CLIが検出されませんでした。`,
    selectMachineTitle: "マシンを選択",
    selectMachineDescription: "このセッションを実行する場所を選択します。",
    selectPathTitle: "パスを選択",
    selectWorkingDirectoryTitle: "作業ディレクトリを選択",
    selectWorkingDirectoryDescription:
      "コマンドとコンテキストに使用するフォルダを選択してください。",
    selectPermissionModeTitle: "権限モードを選択",
    selectPermissionModeDescription: "操作にどの程度承認が必要かを設定します。",
    selectModelTitle: "AIモデルを選択",
    selectModelDescription:
      "このセッションで使用するモデルを選択してください。",
      checkout: {
        selectTitle: "チェックアウトを選択",
        noWorktree: "現在のフォルダー",
        noWorktreeSubtitle:
        "すでに選択したフォルダーを使い、ワークスペースのチェックアウトはリンクしません。",
        noWorktreeSectionTitle: "現在のフォルダー",
        existingWorktreesSectionTitle: "リンク済みチェックアウト",
        actionsSectionTitle: "アクション",
        newWorktree: "新しいワークツリー",
        newWorktreeSubtitle: "このセッション用に新しい Git ワークツリーを作成して使用します。",
        pendingWorktreeSubtitle: ({ branch, path }: { branch: string; path: string }) => `${branch} から · ${path}`,
        existingWorktree: "既存のワークツリー",
        existingWorktreeSubtitle: "このセッションで既存の Git ワークツリーを選択します。",
        existingWorktreeEmptyTitle: "既存のワークツリーはありません",
        existingWorktreeEmptySubtitle:
        "先に Git ワークツリーを作成するか、新しいワークツリーを選択してください。",
        newWorktreeDetailWorkspace:
        "このワークスペースに新しいリンク済みチェックアウトを作成します。",
        newWorktreeDetailBranch:
        "現在のリポジトリ状態から開始し、新しいブランチ/ワークツリー名を選びます。",
      branchPickerTitle: "開始元",
      branchPickerCurrentHead: "現在のブランチ",
      branchPickerCurrentHeadDescription: "このリポジトリで現在チェックアウト中のブランチから開始します。",
      branchPickerEmpty: "このリポジトリで利用できるブランチはありません。",
      branchPickerSearchPlaceholder: "ブランチを検索…",
      branchPickerRefreshA11y: "ブランチを更新",
      branchPickerLoadingA11y: "ブランチを読み込み中",
      branchPickerRefreshingA11y: "ブランチを更新中",
        primaryDetailDescription:
        "選択したマシン上で、このワークスペースのメインのリンク済みチェックアウトを使います。",
        gitWorktreeDetailDescription:
        "このセッションに既存のリンク済み Git ワークツリーチェックアウトを使います。",
        existingBranchWorktreeDescription:
        "このブランチには既にワークツリーがあります。直接再利用するか、そこから新しいブランチを作成できます。",
        existingBranchDescription:
        "このブランチは新しいワークツリーで直接使うことも、そこから新しいブランチを作成することもできます。",
        createNewBranchFromBranchHint:
        "このブランチから新しいブランチとワークツリーを作成するには、Apply を使ってください。",
      useExistingBranchAction: "既存のブランチを使用",
      useExistingWorktreeAction: "既存のワークツリーを使用",
      detailBranch: ({ branch }: { branch: string }) => `ブランチ: ${branch}`,
      detailPath: ({ path }: { path: string }) => `パス: ${path}`,
      detailLinkedWorkspace: "現在のワークスペースにリンクされています。",
    },
    selectSessionTypeTitle: "セッションタイプを選択",
    selectSessionTypeDescription:
      "シンプルなセッション、またはGitのワークツリーに紐づくセッションを選択してください。",
    searchPathsPlaceholder: "パスを検索…",
    noMachinesFound:
      "マシンが見つかりません。まずコンピューターでHappierセッションを起動してください。",
    allMachinesOffline: "すべてのマシンがオフラインです",
    machineOfflineInlineTitle: "マシンがオフラインです",
    machineOfflineInlineBody:
      "このマシンでデーモンを起動するか、別のマシンを選んでからセッションを作成してください。",
    machineOfflineCannotStartStatus: "オフライン（セッションを開始できません）",
    automationChip: {
      default: "自動化",
      interval: ({ minutes }: { minutes: number }) => `${minutes}分ごと`,
      cron: "Cron スケジュール",
    },
    machineDetails: "マシンの詳細を表示 →",
    directoryDoesNotExist: "ディレクトリが見つかりません",
    createDirectoryConfirm: ({ directory }: { directory: string }) =>
      `ディレクトリ ${directory} は存在しません。作成しますか？`,
    sessionStarted: "セッションが開始されました",
    sessionStartedMessage: "セッションが正常に開始されました。",
    sessionSpawningFailed:
      "セッションの生成に失敗しました - セッションIDが返されませんでした。",
    startingSession: "セッションを開始中...",
    startNewSessionInFolder: "このフォルダで新しいセッション",
    failedToStart:
      "セッションを開始できませんでした。もう一度試すか、選択したマシンとセッション設定を確認してください。",
    actionMethodUnavailable: "新しいセッションを作成するには、対象のマシンで Happier を更新してください。",
    sessionTimeout:
      "セッションの開始がタイムアウトしました。マシンが遅いか、デーモンが応答していない可能性があります。",
    notConnectedToServer:
      "サーバーに接続されていません。インターネット接続を確認してください。",
    daemonRpcUnavailableTitle: "デーモンを利用できません",
    daemonRpcUnavailableBody:
      "このマシン上のデーモンに接続できません。オフライン、起動中、またはサーバーから切断されている可能性があります。",
    launchStillPendingTitle: "起動処理はまだ進行中です",
    launchStillPendingBody:
      "Happier はまだ新しいセッションを確認できていません。起動リクエストは保存されています。重複するセッションを作成せずに同じ起動を続けるには、再試行してください。",
    connectedServiceSwitchUnavailable: {
      startFreshAction: "新しいアカウントで最初から始める",
    },
    noMachineSelected: "セッションを開始するマシンを選択してください",
    noPathSelected: "セッションを開始するディレクトリを選択してください",
    machinePicker: {
      searchPlaceholder: "マシンを検索...",
      recentTitle: "最近",
      favoritesTitle: "お気に入り",
      allTitle: "すべて",
      emptyMessage: "利用可能なマシンがありません",
    },
    pathPicker: {
      enterPathTitle: "パスを入力",
      enterPathPlaceholder: "パスを入力...",
      customPathTitle: "カスタムパス",
      truncatedDirectoryInfo: ({ count }: { count: number }) => `最初の${count}件を表示`,
      recentTitle: "最近",
      favoritesTitle: "お気に入り",
      suggestedTitle: "おすすめ",
      allTitle: "すべて",
      emptyRecent: "最近のパスはありません",
      emptyFavorites: "お気に入りのパスはありません",
      emptySuggested: "おすすめのパスはありません",
      emptyAll: "パスがありません",
      inThisFolderTitle: "このフォルダー内",
      openInTreeBrowserLabel: "ツリーブラウザーで開く",
      openFolderLabel: "フォルダーの内容を表示",
      emptyInThisFolder: "このフォルダーに一致するものはありません",
      favoriteAdd: "お気に入りに追加",
      favoriteRemove: "お気に入りから削除",
      hints: {
        navigate: "移動",
        commit: "パスを確定",
        autocomplete: "自動補完",
        walkUp: "1つ上の階層へ",
      },
    },
    sessionType: {
      title: "セッションタイプ",
      simple: "シンプル",
      worktree: "ワークツリー",
      comingSoon: "近日公開",
    },
    profileAvailability: {
      requiresAgent: ({ agent }: { agent: string }) => `${agent} が必要`,
      cliNotDetected: ({ cli }: { cli: string }) =>
        `${cli} CLI が検出されません`,
    },
    profileSelection: {
      workspaceDefault: "ワークスペースの既定",
    },
    cliBanners: {
      cliNotDetectedTitle: ({ cli }: { cli: string }) =>
        `${cli} CLI が検出されません`,
      dontShowFor: "このポップアップを表示しない:",
      thisMachine: "このマシン",
      anyMachine: "すべてのマシン",
      installCommand: ({ command }: { command: string }) =>
        `インストール: ${command} •`,
      installCliIfAvailable: ({ cli }: { cli: string }) =>
        `${cli} CLI が利用可能ならインストール •`,
      viewInstallationGuide: "インストールガイドを見る →",
      viewGeminiDocs: "Geminiドキュメントを見る →",
    },
    worktree: {
      creating: ({ name }: { name: string }) =>
        `ワークツリー '${name}' を作成中...`,
      notGitRepo: "ワークツリーにはGitリポジトリが必要です",
      failed: ({ error }: { error: string }) =>
        `ワークツリーの作成に失敗しました: ${error}`,
      success: "ワークツリーが正常に作成されました",
      createTitle: "ブランチから新しいワークツリー",
      backToRoot: "ワークツリー",
      searchPlaceholder: "ワークツリーを検索",
      searchBranchPlaceholder: "ブランチを検索",
      sections: {
        localBranches: "ローカルブランチ",
        remoteBranches: "リモートブランチ",
      },
      statusPill: {
        clean: "クリーン",
        idle: "アイドル",
        // FR4-10: StatusPill renders the count separately; suffix-only. Japanese
        // does not pluralize nouns, so both singular and plural return the same word.
        changesSuffix: (_params: { count: number }) => "変更",
      },
      branchRow: {
        reuseLabel: "ワークツリーあり",
        reuseSubtitle: ({ path }: { path: string }) => path,
      },
      nameStep: {
        title: "ワークツリーに名前を付ける",
        backLabel: "ブランチ",
        placeholder: "このワークツリーに名前を付ける",
        emptyHint: "これが新しいブランチとワークツリーの名前になります。",
        suggestedSectionTitle: "候補",
        suggestedSubtitle: "生成された名前を使う",
        useSuggested: ({ name }: { name: string }) => `提案された名前を使う: ${name}`,
        createNamed: ({ name }: { name: string }) => `ワークツリーを作成: ${name}`,
        customHint: "または上に名前を入力してカスタムワークツリーを作成",
        hints: {
          create: "作成",
          back: "戻る",
        },
      },
      reuseOrCreate: {
        title: "ブランチには既にワークツリーがあります",
        useExisting: "既存のワークツリーを使う",
        createNew: "このブランチから新しいワークツリーを作成",
        createNewSubtitle: "分岐して名前付きの新しいワークツリーにする",
      },
      hints: {
        navigate: "移動",
        select: "選択",
        back: "戻る",
      },
    },
    resume: {
      title: "セッションを再開",
      optional: "再開: 任意",
      chipOptional: ({ agent }: { agent: string }) => `${agent}セッションを再開`,
      pickerTitle: "セッションを再開",
      subtitle: ({ agent }: { agent: string }) =>
        `再開する${agent}セッションIDを貼り付けてください`,
      placeholder: ({ agent }: { agent: string }) =>
        `${agent}セッションIDを貼り付け…`,
      browse: "セッションを閲覧",
      paste: "貼り付け",
      save: "保存",
      clearAndRemove: "クリア",
      helpText: "セッションIDは「セッション情報」画面で確認できます。",
      cannotApplyBody:
        "この再開IDは現在適用できません。代わりに新しいセッションを開始します。",
    },
    codexResumeBanner: {
      title: "Codex 再開サーバー",
      updateAvailable: "更新があります",
      systemCodexVersion: ({ version }: { version: string }) =>
        `システム Codex: ${version}`,
      resumeServerVersion: ({ version }: { version: string }) =>
        `Codex resume サーバー: ${version}`,
      notInstalled: "未インストール",
      latestVersion: ({ version }: { version: string }) => `(最新 ${version})`,
      registryCheckFailed: ({ error }: { error: string }) =>
        `レジストリの確認に失敗しました: ${error}`,
      install: "インストール",
      update: "更新",
      reinstall: "再インストール",
    },
    codexResumeInstallModal: {
      installTitle: "Codex 再開サーバーをインストールしますか？",
      updateTitle: "Codex 再開サーバーを更新しますか？",
      reinstallTitle: "Codex 再開サーバーを再インストールしますか？",
      description:
        "これは再開操作にのみ使用する、実験的な Codex MCP サーバーラッパーをインストールします。",
    },
    codexAcpBanner: {
      title: "Codex ACP",
      install: "インストール",
      update: "更新",
      reinstall: "再インストール",
    },
    codexAcpInstallModal: {
      installTitle: "Codex ACP をインストールしますか？",
      updateTitle: "Codex ACP を更新しますか？",
      reinstallTitle: "Codex ACP を再インストールしますか？",
      description:
        "これはスレッドの読み込み/再開に対応した、Codex 向けの実験的な ACP アダプターをインストールします。",
    },
        githubCliBanner: {
            title: 'GitHub CLI',
            install: 'インストール',
            update: '更新',
            reinstall: '再インストール',
        },
    githubCliInstallModal: {
      installTitle: "GitHub CLI をインストールしますか？",
      updateTitle: "GitHub CLI を更新しますか？",
      reinstallTitle: "GitHub CLI を再インストールしますか？",
      description:
        "Happier が pull request ワークフローでローカルの GitHub 認証を使用できるように GitHub CLI をインストールします。",
    },

    ghCliBanner: {
      title: "GitHub CLI",
      install: "インストール",
      update: "更新",
      reinstall: "再インストール",
    },
    ghCliInstallModal: {
      installTitle: "GitHub CLI をインストールしますか？",
      updateTitle: "GitHub CLI を更新しますか？",
      reinstallTitle: "GitHub CLI を再インストールしますか？",
      description:
        "確認後、GitHub のソース管理ワークフローで使用する任意の GitHub CLI 依存関係をインストールします。",
    },},

  sessionHistory: {
    // Used by session history screen
    title: "セッション履歴",
    empty: "セッションが見つかりません",
    today: "今日",
    yesterday: "昨日",
    daysAgo: ({ count }: { count: number }) => `${count}日前`,
    viewAll: "すべてのセッションを表示",
  },

  sessionHandoff: sessionHandoffTranslationExtensions.ja,

  session: {
    providerBinding: providerSessionTranslations.ja,
    transcriptNavigation: {
      title: "ナビゲート",
      modeAll: "すべて",
      modePinned: "ピン留め",
      entryCount: ({ count }: { count: number }) => `${count} 件`,
      pinnedCount: ({ count }: { count: number }) => `${count} 件のピン留め`,
      emptyPinnedTitle: "ピン留めされたメッセージはありません",
      emptyPinnedBody: "重要なターンをここに残すにはメッセージをピン留めします。",
      emptyAllTitle: "ナビゲーション項目はありません",
      emptyAllBody: "ユーザーのターンとピン留めメッセージがここに表示されます。",
      entryA11y: ({ label }: { label: string }) => `${label} に移動`,
      entryPinnedA11y: ({ label }: { label: string }) => `ピン留めメッセージに移動: ${label}`,
      fallbackPinnedAssistant: "ピン留めされたアシスタントメッセージ",
      fallbackPinnedTool: "ピン留めされたツールメッセージ",
      fallbackPinnedMessage: "ピン留めされたメッセージ",
      pinMessageA11y: "メッセージをピン留め",
      unpinMessageA11y: "メッセージのピン留めを解除",
      pinToolCallA11y: "ツール呼び出しをピン留め",
      unpinToolCallA11y: "ツール呼び出しのピン留めを解除",
      jumpFailed: "このメッセージに移動できませんでした。",
      replyNotLoaded: "返信はまだ読み込まれていません",
      awaitingReply: "返信を待っています",
      loadingBody: "会話のナビゲーションを読み込んでいます…",
      railScrollUpA11y: "ナビゲーションを上にスクロール",
      railScrollDownA11y: "ナビゲーションを下にスクロール",
      emptyPinnedHint: "メッセージにカーソルを合わせてピンアイコンを選ぶと固定できます。",
      emptyPinnedPrivacy: "ピン留めはこのデバイスにのみ保存されます。",
    },

    inputPlaceholder: "メッセージを入力...",
    workState: {
      accessibilityLabel: "セッション作業状態",
      commandDescription: "セッションの目標を設定または確認",
      unsupportedTitle: "目標を使用できません",
      unsupportedMessage:
        "このバックエンドは編集可能なセッション目標をまだサポートしていません。",
      notReadyTitle: "目標コントロールはまだ準備できていません",
      notReadyMessage:
        "このセッションはまだ起動中です。少し待ってから目標をもう一度設定してください。",
      noCurrentGoalTitle: "更新する目標がありません",
      noCurrentGoalMessage:
        "一時停止または再開する前に目標を設定してください。",
      dirtyCloseTitle: "目標の編集を破棄しますか？",
      dirtyCloseBody: "保存されていない目標の変更は失われます。",
      emptyPlaceholder: "まだ何もありません",
      badge: {
        goal: ({ title }: { title: string }) => `目標: ${title}`,
        goalPaused: "目標は一時停止中",
        goalBlocked: "目標はブロック中",
        goalBudgetLimited: "目標は予算制限中",
        goalComplete: "目標は完了",
        item: ({ title }: { title: string }) => title,
      },
      group: {
        active: "進行中",
        pending: "保留中",
        blockedPaused: "ブロック中または一時停止中",
        done: "完了またはキャンセル",
      },
      workflow: {
          sectionTitle: "アクティブなワークフロー",
          goalActive: "目標がアクティブ",
          goalLabel: ({ title }: { title: string }) => `目標: ${title}`,
          bare: "ワークフロー",
          agentsFallback: ({ fraction }: { fraction: string }) => `ワークフロー ${fraction} エージェント`,
          olderRunsHidden: ({ count }: { count: number }) => `${count} 件の実行は非表示`,
          phaseLabel: ({ title, fraction }: { title: string; fraction: string }) => `${title} ${fraction}`,
          plural: ({ count }: { count: number }) => `${count} 個のワークフロー`,
          pluralWithAgents: ({ count, agents }: { count: number; agents: number }) => `${count} 個のワークフロー · ${agents} エージェント`,
          join: ({ left, right }: { left: string; right: string }) => `${left} · ${right}`,
          permissionBlocked: "確認が必要",
      },
      goal: {
        title: "目標",
        placeholder: "このセッションでは何に集中しますか？",
        set: "目標を設定",
        pause: "一時停止",
        resume: "再開",
        clear: "クリア",
        clearTitle: "目標をクリアしますか？",
        clearBody: "このセッションから編集可能な目標を削除します。",
        statusActive: "進行中",
        statusPaused: "一時停止中",
        statusComplete: "完了",
        statusBudgetLimited: "予算制限中",
        statusInterrupted: "中断",
        setTitle: "目標を設定",
        setSubtitle: "セッションに焦点を定めて、エージェントが軌道を外れないようにします。",
        addBudget: "+ 予算の上限を追加（任意）",
        removeBudget: "予算を削除",
        noUsageYet: "まだ使用なし",
        tokenBudget: "トークン予算",
        tokensSuffix: ({ count }: { count: string }) => `${count} トークン`,
        budgetProgress: ({ used, budget }: { used: string; budget: string }) => `${used} / ${budget}`,
        budgetCaption: ({ budget }: { budget: string }) => `予算 ${budget} 中`,
        budgetPlaceholder: "トークン上限",
        invalidBudget: "正のトークン予算を入力してください。",
        pending: "目標を設定中…",
        stillWaiting: "確認を待っています…",
        accessibilityCurrent: ({ objective }: { objective: string }) => `現在の目標: ${objective}`,
        errorUnsupportedResponse: "セッション RPC からサポートされていない応答が返されました",
        errorUnknown: "不明なエラー",
        errorCannotResume: "ネイティブ目標の更新のためにセッションを再開できません",
      },
    },
    usageLimitRecovery: {
      banner: {
        title: "使用上限に達しました",
        body: "Happier は上限のリセットを待って、このセッションを自動的に再開できます。",
        waitingTitle: "使用上限のリセットを待機中",
        waitingBody: "プロバイダーがリクエストを受け付ける見込みの時刻に、Happier が再確認します。",
        readyTitle: "使用上限がリセットされました",
        readyBody: "このセッションを今すぐ再開できます。",
        resetCreditSummary: ({ count, expiresAt }: { count: number; expiresAt: string | null }) => {
          const label = count === 1 ? "使用リセット 1 件" : `使用リセット ${count} 件`;
          return expiresAt ? `${label}が利用可能です。最も早い期限は ${expiresAt} です。` : `${label}が利用可能です。`;
        },
      },
      actions: {
        enable: "上限がリセットされたら再開",
        cancel: "待機をキャンセル",
        checkNow: "上限を今すぐ確認",
        resumeNow: "今すぐ再開",
        switchFallbackNow: "代替アカウントに切り替え",
        switchAccountNow: "今すぐアカウントを切り替え",
        consumeResetCredit: "使用リセットを適用",
        retryTemporaryThrottle: "今すぐ再試行",
        remember: "常に待機して再開",
        forget: "毎回確認",
        hideBanner: "使用制限バナーを非表示",
        showBanner: "使用制限バナーを表示",
      },
      status: {
        ready: "使用上限",
        resumeReady: "再開できます",
        checking: "上限を確認中",
        waiting: "リセット待機中",
        waitingForQuotaReset: "クォータのリセット待機中",
        accountRotationPending: "アカウント切り替え待機中",
        temporaryThrottle: "一時的な制限",
      },
    },
    composerBanners: {
        showBannerAction: 'バナーを表示',
        hideBannerAction: 'バナーを非表示',
    },
    staleRunner: {
      banner: {
        title: "セッションランナーが古くなっています",
        body: "このセッションは古いランタイムコードで実行されています。現在のデーモン runtime を使うにはランナーを再起動してください。",
        pendingBody: "現在のデーモン runtime でセッションランナーを再起動しています。",
        busyBody: "ランナーは現在処理中です。現在の作業が終わってからもう一度試してください。",
        failedBody: "ランナーを再起動できませんでした。セッションは既存のランナーで引き続き利用できます。",
        unavailableBody: "このセッションでは再起動を利用できません。セッションは既存のランナーで引き続き実行できます。",
      },
      actions: {
        restart: "ランナーを再起動",
        restarting: "再起動中...",
        hideBanner: "古いランナーのバナーを非表示",
        showBanner: "古いランナーのバナーを表示",
      },
      status: {
        stale: "ランナー更新",
        restarting: "ランナー再起動中",
        busy: "ランナー処理中",
        failed: "ランナー再起動失敗",
      },
    },
    rightPanel: {
      tabs: {
        git: "Git",
      },
    },
    toolCalls: "ツール呼び出し",
    toolCallsCollapsedPreviewMore: ({ count }: { count: number }) => `+${count} 件…`,
    agentContinuation: {
      currentAgentAccessibilityLabel: ({ agent }: { agent: string }) => `${agent}。このセッションを実行中です。`,
      currentAgentLastUsedAccessibilityLabel: ({ agent }: { agent: string }) => `${agent}。このセッションで最後に使用されました。`,
      currentAgentLastReportedAccessibilityLabel: ({ agent }: { agent: string }) => `${agent}。このセッションで最後に報告されました。`,
      armedAccessibilityLabel: ({ agent }: { agent: string }) => `${agent}。次のメッセージ用に選択済みです。`,
      detailTitle: ({ agent }: { agent: string }) => `${agent} で続ける`,
      sendLabel: ({ agent }: { agent: string }) => `${agent} で続ける`,
      detailDescription: '最近の会話はテキストとして引き継がれます。画像やファイルは引き継がれません。次のメッセージを送るまで何も送信されません。',
      announcement: ({ agent }: { agent: string }) => `次のメッセージ用に ${agent} を選択しました。まだ何も送信されていません。`,
      dividerTitle: ({ from: from_, to }: { from: string; to: string }) => `このセッションは ${from_} から ${to} に引き継がれました`,
      checking: "利用可否を確認しています…",
      unavailable: {
        unsupportedSession: ({ agent }: { agent: string }) => `このセッションを ${agent} で続けることはできません。`,
        updateCli: "エージェントを切り替えるには、このマシンの CLI を更新してください。",
        updateOrReconnect: "エージェントを切り替えるには CLI を更新するか再接続してください。",
        targetNoSessions: ({ agent }: { agent: string }) => `${agent} はセッションを実行できません。`,
        targetNotProven: ({ agent }: { agent: string }) => `${agent} への切り替えはまだ利用できません。`,
        targetUnavailable: ({ agent }: { agent: string }) => `${agent} はこのマシンでは利用できません。`,
      },
      transition: {
        rejected: {
          unsupportedOperation: 'このセッションではエージェントの切り替えに対応していません。何も送信されていません。',
          forbidden: 'このセッションのエージェントを切り替える権限がありません。何も送信されていません。',
          sameTarget: ({ agent }: { agent: string }) => `このセッションはすでに ${agent} で実行中です。何も送信されていません。`,
          staleSelection: '選択中にセッションが変わりました。何も送信されていません。もう一度お試しください。',
          targetUnavailable: ({ agent }: { agent: string }) => `${agent} はこのマシンでは利用できません。何も送信されていません。`,
          sourceNotIdle: ({ agent }: { agent: string }) => `${agent} はまだ作業中です。何も送信されていません。完了してからもう一度お試しください。`,
          sourceStopFailed: ({ agent }: { agent: string }) => `${agent} を停止できなかったため、何も変わっていません。何も送信されていません。`,
        },
        conflictingDestination: ({ agent }: { agent: string }) => `何も送信されていません。このメッセージには別の宛先がすでにあるため、同時にこのセッションを ${agent} に切り替えることはできません。どちらかを解除してから、もう一度送信してください。`,
        sourceStopped: ({ source, agent }: { source: string; agent: string }) => `${source} は停止しましたが、${agent} への切り替えは完了しませんでした。メッセージは送信されていません。`,
        switched: ({ agent }: { agent: string }) => `このセッションは ${agent} になりましたが、メッセージは送信されていません。もう一度送信してください。`,
        /** Compact status for the collapsed composer banner badge. */
        badgeLabel: 'エージェントの切り替え',
        /** Delegates to the Session’s existing resume owner; never a second start path. */
        resumeAction: 'セッションを再開',
        unknown: 'Happier は結果を確認できませんでした。もう一度送信する前にこのセッションを確認してください。',
      },
    },
    sourceContext: {
        chipLabel: ({ session }: { session: string }) => `${session} から`,
        unknownSession: "別のセッション",
        detailTitle: "別のセッションからの継続",
        detailBodyLatest: ({ session }: { session: string }) => `${session} の会話が、この新しいセッションのコンテキストとして引き継がれます。`,
        detailBodyAtMessage: ({ session }: { session: string }) => `${session} の会話が、選んだメッセージまで、この新しいセッションのコンテキストとして引き継がれます。`,
        carriedOver: "会話が引き継がれます",
        removeAction: "削除",
        removeA11y: "元の会話を削除",
        keepAction: "そのままにする",
        serverMismatch: "その会話は別の Happier サーバーにあります。そのサーバーに切り替えるか、元の会話を削除して新規に開始してください。",
    },
    forking: {
      dividerTitle: "以前のコンテキストから分岐しました",
      dividerTitleWithParent: ({ parent }: { parent: string }) => `${parent} から分岐しました`,
      dividerSubtitle: "以前のコンテキスト（読み取り専用）",
      openParent: "開く",
      openParentA11y: "親セッションを開く",
      forkFromMessageA11y: "このメッセージから分岐",
      strategy: {
          title: "このセッションを分岐",
          subtitleLatest: "この会話の現在地点から分岐します。",
          subtitleFromMessage: "会話のこの地点から分岐します。",
          recommended: "おすすめ",
          native: {
              title: "ネイティブ分岐",
              subtitle: "エージェント自身の会話を分岐します。元の状態に最も近い方法です。",
          },
          replay: {
              title: "Replay 分岐",
              subtitle: "Happier がここまでの会話を再生し、新しいセッションのコンテキストにします。",
          },
          configure: {
              title: "新しいセッションを設定",
              subtitle: "別のエージェント、モデル、マシン、フォルダーを選び、この会話を引き継ぎます。",
          },
          progress: {
              creatingNative: "ネイティブ分岐を作成中…",
              creatingReplay: "Replay 分岐を作成中…",
              opening: "分岐を開いています…",
              stalledTitle: "分岐は作成されました",
              stalledBody: "まだここに表示されていません。もう一度開いてみてください。",
              openAction: "分岐を開く",
          },
          unknown: {
              title: "Happier は分岐を確認できませんでした",
              body: "リクエストは送信済みなので、分岐がすでに存在する可能性があります。もう一度分岐せずに確認してください。二度目の試行は重複を作るおそれがあります。",
              checkAction: "分岐を確認",
              checking: "分岐を探しています…",
              noneFound: "一致する分岐はまだありません。起動中の可能性があるため、もう一度確認できます。",
              ambiguous: "一致する分岐が複数見つかりました。セッション一覧を開いて正しいものを選んでください。",
          },
          failure: {
              updateRequired: "このセッションを分岐するには、このマシンの CLI を更新するか再接続してください。",
              generic: "Happier は分岐を作成できませんでした。",
          },
      },
	    },
	    transcriptGap: {
	      earlierMessages: "前のメッセージ",
	      laterMessages: "後のメッセージ",
	    },
	    rollback: {
	      latestTurnA11y: '最新のターンをロールバック',
	      beforeUserMessageA11y: 'このメッセージの前までロールバック',

	      checkpointCode: {
	        title: 'ロールバックの選択',
	        conversationUnavailable: 'このセッションでは会話のロールバックを利用できません。',
	        codeOnlyConfirmation: '会話は変更されないことを理解しました。',
	        showAdvanced: 'コードのみの詳細オプションを表示',
	        choices: {
	          conversation_only: {
	            title: '会話のみ',
	            description: 'ファイルを変更せずにトランスクリプトだけをロールバックします。',
	          },
	          conversation_and_code_with_stash: {
	            title: '会話とコード、Git stash あり',
	            description: 'Happier バックアップチェックポイントを作成し、変更を stash してから逆パッチを適用します。',
	          },
	          conversation_and_code_without_stash: {
	            title: '会話とコード、Git stash なし',
	            description: 'Happier バックアップチェックポイントを作成し、この worktree に逆パッチを適用します。',
	          },
	          code_only_with_stash: {
	            title: 'コードのみ、Git stash あり',
	            description: '詳細: 会話はそのままにし、stash バックアップ後にファイルをロールバックします。',
	          },
	          code_only_without_stash: {
	            title: 'コードのみ、Git stash なし',
	            description: '詳細: 会話はそのままにし、Happier バックアップチェックポイントだけでファイルをロールバックします。',
	          },
	        },
	      },},
	    resuming: "再開中...",
	    resumeFailed: "セッションの再開に失敗しました",
	    pendingQueuedResumeFailedTitle: "メッセージはキューに保存されました",
	    pendingQueuedResumeFailedBody:
	      "メッセージは保留キューに保存されましたが、Happier はこのセッションを再開できませんでした。再試行して開始してください。",
	    invalidLinkTitle: "無効なセッションリンク",
	    invalidLinkDescription: "セッションリンクが見つからないか無効です。URL を確認してもう一度お試しください。",
	    resumeSupportNoteChecking:
	      "注: Happier はこのマシンでプロバイダーのセッションを再開できるか確認中です。",
	    resumeSupportNoteUnverified:
	      "注: Happier はこのマシンでの再開サポートを確認できませんでした。",
    resumeSupportDetails: {
      cliNotDetected: "このマシンで CLI が検出されませんでした。",
      capabilityProbeFailed: "機能の確認に失敗しました。",
      acpProbeFailed: "ACP の確認に失敗しました。",
      loadSessionFalse:
        "エージェントはセッションの読み込みをサポートしていません。",
    },
    inactiveResumable: "非アクティブ（再開可能）",
    inactiveMachineOffline: "非アクティブ（マシンがオフライン）",
    inactiveNotResumable: "非アクティブ",
    inactiveNotResumableNoticeTitle: "このセッションは再開できません",
    inactiveNotResumableNoticeBody: ({ provider }: { provider: string }) =>
      `このセッションは終了しており、${provider} がここでコンテキストの復元をサポートしていないため再開できません。続けるには新しいセッションを開始してください。`,
    machineOfflineNoticeTitle: "マシンがオフラインです",
    machineOfflineNoticeBody: ({ machine }: { machine: string }) =>
      `“${machine}” がオフラインのため、Happier はまだこのセッションを再開できません。オンラインに戻して続行してください。`,
      machineOfflineCannotResume:
        "マシンがオフラインです。オンラインに戻してこのセッションを再開してください。",
        openRuns: "セッションの実行を開く",
        openAutomations: "セッションの自動化を開く",
        openSubagents: ({ count }: { count: number }) => (count > 0 ? `エージェントを開く (${count})` : 'エージェントを開く'),
        participants: {
          to: '宛先',
          lead: 'メイン',
          sendToTitle: '送信先',
          broadcast: ({ teamId }: { teamId: string }) => `ブロードキャスト: ${teamId}`,
          executionRun: ({ runId }: { runId: string }) => `実行 ${runId}`,
          cardTo: ({ label }: { label: string }) => `宛先: ${label}`,
          unsupportedAttachmentsOrReviewComments: '宛先指定での送信は現在、添付ファイルやレビューコメントに対応していません。',
        },
        subagents: {
          messages: {
            teamLabel: ({ teamId }: { teamId: string }) => `Team: ${teamId}`,
            memberLabel: ({ memberLabel, teamId }: { memberLabel: string; teamId: string }) =>
              `${memberLabel} · ${teamId}`,
            launch: {
              createTeamTitle: "チームを作成",
              createMemberTitle: "チームメイトを起動",
            },
            command: {
              deleteTeamTitle: "チームを削除",
              deleteMemberTitle: "チームメイトを停止",
            },
          },
                    panel: {
            title: "エージェント",
            active: "稼働中",
            recent: "最近",
            emptyActive: "稼働中のエージェントはありません。",
            emptyRecent: "最近のエージェントはまだありません。",
            openFull: "全画面表示を開く",
            openAdvancedRun: "ランの詳細",
            send: "メッセージを送信",
            delete: "削除",
            launchSectionTitle: "起動",
            launchSectionSubtitle: "このセッションから新しいエージェントと実行ランを開始します。",
            sectionCount: ({ count }: { count: number }) => `${count}`,
            groupCount: ({ count }: { count: number }) => `${count} エージェント`,
            launchExecutionRunsTitle: "実行ランを開始",
            launchExecutionRunsSubtitle: "レビュー・計画・委任のプリセットで実行ランチャーを開きます。",
            launchExecutionRunsAdvanced: "詳細…",
            launchClaudeTeamsTitle: "Claude チームを起動",
            launchClaudeTeamsSubtitle: "構造化された Claude チームコマンドでチームを作成するか、チームメイトを起動します。",
            teamIdLabel: "チーム ID",
            teamIdPlaceholder: "チーム-id",
            teamDescriptionPlaceholder: "このチームの担当は何ですか？",
            launchClaudeTeamA11y: "Claude チームを作成",
            launchClaudeTeamAction: "チームを作成",
            teammateTeamIdLabel: "チームメイトのチーム",
            teammateLabelPlaceholder: "チームメイトのラベル",
            teammateInstructionsPlaceholder: "このチームメイトは何をするべきですか？",
            launchTeammateA11y: "チームメイトを起動",
            launchTeammateAction: "チームメイトを起動",
            typeFact: ({ value }: { value: string }) => `種類: ${value}`,
            providerFact: ({ value }: { value: string }) => `プロバイダー: ${value}`,
            backendFact: ({ value }: { value: string }) => `バックエンド: ${value}`,
            intentFact: ({ value }: { value: string }) => `インテント: ${value}`,
            errors: {
              teamIdRequired: "先にチーム ID を入力してください。",
              memberTeamIdRequired: "先にチームメイトのチーム ID を入力してください。",
              memberLabelRequired: "先にチームメイトのラベルを入力してください。",
              memberInstructionsRequired: "先にチームメイトへの指示を入力してください。",
            },
          },
          details: {
            unavailable: "このエージェントの文字起こしはもう利用できません。",
          },
          kind: {
            execution_run: "実行",
            agent_team_member: "チームエージェント",
            subagent_sidechain: "サブエージェント",
          },
          intent: {
            review: "レビュー",
            plan: "計画",
            delegate: "委任",
          },
        },
        actionMenu: {
          openA11y: "セッションの操作を開く",

          backgroundFollow: "バックグラウンドで追跡",},
      detailsPanel: {
        emptyHint: "右側パネルからファイルまたは差分を開いてください。",
        unsupportedTab: "未対応の詳細タブです。",
        closeA11y: "詳細を閉じる",
          openRightSidebarA11y: "右サイドバーを開く",
          closeRightSidebarA11y: "右サイドバーを閉じる",
          openTabA11y: ({ title }: { title: string }) => `${title} を開く`,
          pinTabA11y: "タブを固定",
          unpinTabA11y: "タブの固定を解除",
          pinnedTabA11y: "固定されたタブ",
          closeTabA11y: "タブを閉じる",
          enterFocusModeA11y: "ペイン集中モードに入る",
          exitFocusModeA11y: "ペイン集中モードを終了",

        emptyTitle: "開いているタブはありません",},

      actionsDraft: {
        noInputHints: "このアクションには入力ヒントがありません。",
        validation: {
          requiredField: ({ field }: { field: string }) =>
            `${field} は必須です。`,
        },
      },

    planOutput: {
      title: "プラン",
      recommendedBackend: "推奨バックエンド",
      risks: "リスク",
      milestones: "マイルストーン",
      adoptPlan: "プランを採用",
      sending: "送信中…",
      failedToAdopt: "プランの採用に失敗しました",
      a11y: {
        adoptPlan: "プランを採用",
      },
    },

    reviewFindings: {
      title: ({ count }: { count: number }) => `レビュー結果（${count}件）`,
      questionsTitle: "レビュアーからの質問",
      assumptionsTitle: "前提",
      findingTitle: ({
        status,
        severity,
        category,
        title,
      }: {
        status: string;
        severity: string;
        category: string;
        title: string;
      }) => `[${status}] [${severity}/${category}] ${title}`,
      status: {
        untriaged: "未決定",
        accept: "修正を実装",
        reject: "無視",
        defer: "後で決める",
        needsRefinement: "説明を求める",
      },
      refinementPlaceholder: "何を確認したいですか？",
      actions: {
        applyTriage: "レビュー対応を適用",
        applying: "適用中…",
        askReviewer: "レビュアーに質問",
        answerQuestion: "レビュアーに回答",
        applyAcceptedFindings: "選択した修正を実装",
        sendFollowUp: "フォローアップを送信",
        sending: "送信中…",
      },
      errors: {
        applyTriageFailed: "レビュー対応を適用できませんでした。",
        followUpFailed: "レビューのフォローアップを送信できませんでした。",
        applyAcceptedFailed: "選択した修正を送信できませんでした。",
      },
    },

      pendingMessages: {
        title: "保留中メッセージ",
        indicator: ({ count }: { count: number }) => `保留中 (${count})`,
        badgeLabel: ({ count }: { count: number }) =>
          count > 0 ? `保留中 (+${count})` : "保留中",
        deliveryStatus: {
          blocked: 'ブロック済み',
          delivering: '配信中',
          queuedInClaude: 'Claude でキュー待ち',
        },
        queuedReasons: {
          waitingForForegroundTurn: '現在のターンの完了を待っています',
          waitingForRuntimeActivity: 'ランタイムの処理完了を待っています',
          runtimeActivityUnknown: 'ランタイムの状態を待っています',
          waitingForPredecessor: '前のメッセージを待っています',
          waitingForRuntime: 'セッションのランタイムを待っています',
          unsupportedAction: '配信アクションの確認が必要です',
        },
        deliveryBlockedReasons: {
          terminalComposerDraft: 'ターミナルの下書きが配信をブロックしています',
          captureStyleUnavailable: 'ターミナルキャプチャでコンポーザーを確認できません',
          providerUnavailableBeforeAcceptance: 'プロバイダーは一時的に利用できません',
          ambiguousTerminalDelivery: '配信状態が不明確です',
          terminalHostUnreachable: 'ターミナルホストに到達できません',
          runtimeDisposedBeforeDelivery: '配信前にランタイムが閉じました',
          runtimeConfigBlocked: 'ランタイム設定が配信をブロックしています',
          invalidPromptText: 'メッセージ本文を配信できません',
          manualUserHandled: '処理済みとしてマーク',
          attemptExpiredBeforeWrite: '書き込み前に配信試行が期限切れになりました',
          providerRejectedBeforeAcceptance: 'プロバイダーがメッセージを拒否しました',
          payloadTooLarge: 'メッセージが大きすぎます',
          unknown: '配信状態の確認が必要です',
        },
	        empty: "保留中のメッセージはありません。",
	        decryptFailed: "この保留メッセージを復号できませんでした。",
	        nonSteerableNotice: "このモード変更後、現在のターンには挿入できません。次に実行されます。すぐに処理するには「今すぐ送信」を使って中断してください。",
	        steerBlockedTerminalDraftNotice: '待機中: ターミナルの入力欄に未送信の下書きがあり配信できません。ターミナルで消去するか、ターンを中断してください。',
        clearComposer: {
          action: '入力欄をクリア',
          clearing: 'クリア中…',
          confirmTitle: 'ターミナルの入力欄をクリアしますか？',
          confirmBody: 'ターミナルの入力欄にある未送信のテキストを破棄します。',
          errors: {
            failed: 'ターミナルの入力欄をクリアできませんでした。',
            unsupported: 'このセッションでは Happier からターミナルの入力欄をクリアできません。',
            noLiveTerminal: 'このセッションで利用できるライブターミナルがありません。',
            generating: 'Claude が生成中のため、入力欄を安全にクリアできません。',
            notSafe: 'ターミナルにダイアログまたは安全でない状態が表示されています。ターミナルで処理してください。',
            captureUnavailable: 'Happier がターミナルの状態を読み取れませんでした。',
          },
        },
	        actions: {
          up: "上へ",
          down: "下へ",
          edit: "編集",
            viewMore: "もっと見る",
            viewLess: "折りたたむ",
          steerNow: "今すぐ挿入",
          sendNow: "今すぐ送信",
          sendToAgentNow: "今すぐエージェントに送信",
          sendNowInterrupt: "今すぐ送信（中断）",
          retryDelivery: "再試行",
          interruptAndRunNow: "中断して今すぐ実行",
          markHandled: "対応済みにする",
          requeue: "キューに戻す",
        },
        editPrompt: {
          title: "保留中メッセージを編集",
        },
        removeConfirm: {
          title: "保留中メッセージを削除しますか？",
          body: "保留中メッセージを削除します。",
        },
        discardConfirm: {
          title: "保留中の配信を破棄しますか？",
          body: "メッセージをエージェントに送信せず、破棄済みとしてトランスクリプトに残します。",
        },
        steerConfirm: {
          title: "今すぐ挿入しますか？",
          body: "現在のターンを止めずに、このメッセージを現在のターンに追加します。",
        },
        sendConfirm: {
          title: "今すぐ送信しますか？",
          interruptTitle: "今すぐ送信（中断）しますか？",
          backgroundTitle: "今すぐエージェントに送信しますか？",
          body: "現在のターンを停止し、このメッセージをすぐに送信します。",
          backgroundBody: "エージェントはこのメッセージを今すぐ受信します。バックグラウンド作業は続行されます。",
          resumeBody: "セッションを再開し、このメッセージをすぐに送信します。",
        },
        markHandledConfirm: {
          title: "保留中メッセージを対応済みにしますか？",
          body: "メッセージを送信せずに、ブロックされた配信状態を解除します。",
        },
        discarded: {
          title: "破棄されたメッセージ",
          subtitle:
            "これらのメッセージはエージェントに送信されませんでした（例: リモートからローカルへ切り替えたとき）。",
          label: "破棄済み",
          removeConfirm: {
            title: "破棄されたメッセージを削除しますか？",
            body: "破棄されたメッセージを削除します。",
          },
        },
        errors: {
          updateFailed: "保留中メッセージの更新に失敗しました",
          deleteFailed: "保留中メッセージの削除に失敗しました",
          sendFailed: "保留中メッセージの送信に失敗しました",
          restoreFailed: "破棄されたメッセージの復元に失敗しました",
          deleteDiscardedFailed: "破棄されたメッセージの削除に失敗しました",
          sendDiscardedFailed: "破棄されたメッセージの送信に失敗しました",
          reorderFailed: "保留中メッセージの並び替えに失敗しました",
          retryDeliveryFailed: "保留中配信の再試行に失敗しました",
          actionConflict: "操作の適用中に保留中のメッセージの状態が変わりました。現在の状態を確認して、もう一度お試しください。",
          discardFailed: "保留中配信の破棄に失敗しました",
          markHandledFailed: "保留中配信を対応済みにできませんでした",
        },
      },
      sharing: {
        title: "共有",
        directSharing: "直接共有",
        addShare: "友達と共有",
      accessLevel: "アクセスレベル",
      shareWith: "共有先",
      sharedWith: "共有中",
      noShares: "未共有",
      viewOnly: "閲覧のみ",
      viewOnlyDescription: "閲覧できますが、メッセージは送信できません。",
      viewOnlyMode: "閲覧のみ（共有セッション）",
      noEditPermission: "このセッションは閲覧専用です。",
      canEdit: "編集可能",
      canEditDescription: "メッセージを送信できます。",
      canManage: "管理可能",
      canManageDescription: "共有設定を管理できます。",
      manageSharingDenied:
        "このセッションの共有設定を管理する権限がありません。",
      stopSharing: "共有を停止",
      stopSharingDescription: "このユーザーの直接アクセスを取り消します。",
      recipientMissingKeys: "このユーザーはまだ暗号化キーを登録していません。",
      permissionApprovals: "権限を承認できる",
      allowPermissionApprovals: "権限承認を許可",
      allowPermissionApprovalsDescription:
        "このユーザーが権限リクエストを承認し、あなたのマシンでツールを実行できるようにします。",
      permissionApprovalsDisabledTitle: "権限承認は無効です",
      permissionApprovalsDisabledPublic:
        "公開リンクは閲覧専用です。権限承認は利用できません。",
      permissionApprovalsDisabledReadOnly: "このセッションは閲覧専用です。",
      permissionApprovalsDisabledInactive:
        "このセッションは非アクティブです。権限承認は利用できません。",
      permissionApprovalsDisabledNotGranted:
        "オーナーはこのセッションでの権限承認を許可していません。",
      publicReadOnlyTitle: "公開リンク（閲覧専用）",
      publicReadOnlyBody:
        "このセッションは公開リンクで共有されています。メッセージとツール出力は閲覧できますが、操作や権限承認はできません。",

      publicLink: "公開リンク",
      publicLinkActive: "公開リンクが有効です",
      publicLinkDescription:
        "このリンクを知っている人は匿名でセッションを閲覧できます。全員のアクセスを取り消すには、リンクを削除または再生成してください。",
      createPublicLink: "公開リンクを作成",
      regeneratePublicLink: "公開リンクを再生成",
      deletePublicLink: "公開リンクを削除",
      linkToken: "リンクトークン",
      tokenNotRecoverable: "トークンは利用できません",
      tokenNotRecoverableDescription:
        "セキュリティ上の理由により、公開リンクのトークンはハッシュ化して保存され復元できません。新しいトークンが必要な場合はリンクを再生成してください。",

      expiresIn: "有効期限",
      expiresOn: "有効期限",
      days7: "7日間",
      days30: "30日間",
      never: "無期限",

      maxUsesLabel: "最大使用回数",
      unlimited: "無制限",
      uses10: "10回使用",
      uses50: "50回使用",
      usageCount: "使用回数",
      usageCountWithMax: ({ used, max }: { used: number; max: number }) =>
        `${used}/${max} 回使用`,
      usageCountUnlimited: ({ used }: { used: number }) => `${used} 回使用`,

      requireConsent: "同意を要求",
      requireConsentDescription: "アクセスを記録する前に同意を求めます。",
      consentRequired: "同意が必要です",
      consentDescription:
        "このリンクでは、IP アドレスとユーザーエージェントを記録するために同意が必要です。",
      acceptAndView: "同意して表示",
      sharedBy: ({ name }: { name: string }) => `${name}さんが共有`,

      shareNotFound: "共有リンクが見つからないか、期限切れです",
      failedToDecrypt: "セッションの復号に失敗しました",
      noMessages: "まだメッセージがありません",
      session: "セッション",
    },
  },

  commandPalette: {
    placeholder: "コマンドを入力または検索...",
    noCommandsFound: "コマンドが見つかりません",
        shortcutsHelpTitle: 'キーボードショートカット',
        shortcutsHelpBody: ({ shortcuts }: { shortcuts: string }) => `有効なショートカット:\n${shortcuts}`,
        shortcutsHelpEmpty: 'このデバイスで有効なショートカットはありません。',
        shortcutsHelpCommandPalette: 'コマンドパレットを開く',
        shortcutsHelpHelp: 'キーボードショートカットを開く',
        shortcutsHelpNewSession: '新規セッション',
        commands: {
            sessionsCategory: 'Sessions',
            navigationCategory: 'Navigation',
            recentSessionsCategory: 'Recent Sessions',
            runsCategory: 'Runs',
            voiceCategory: 'Voice',
            systemCategory: 'System',
            developerCategory: 'Developer',
            newSessionTitle: 'New Session',
            newSessionSubtitle: 'Start a new chat session',
            viewAllSessionsTitle: 'View All Sessions',
            viewAllSessionsSubtitle: 'Browse your chat history',
            settingsTitle: 'Settings',
            settingsSubtitle: 'Configure your preferences',
            accountTitle: 'Account',
            accountSubtitle: 'Manage your account',
            connectTerminalTitle: 'Scan QR to connect terminal',
            connectTerminalSubtitle: 'Approve the connection shown in your terminal',
            memorySearchTitle: 'Search Memory',
            memorySearchSubtitle: 'Search across past conversations',
            sessionFallbackTitle: ({ id }: { id: string }) => `Session ${id}`,
            sessionFallbackSubtitle: 'Switch to session',
            sessionRequiredTitle: 'Session required',
            sessionRequiredBody: 'Open a session first so this command can target it.',
            startReviewRunTitle: 'Start review run',
            startPlanRunTitle: 'Start plan run',
            startDelegationRunTitle: 'Start delegation run',
            executionRunsSubtitle: 'Execution runs',
            openSessionRunsTitle: 'Open session runs',
            runsForCurrentSessionSubtitle: 'Runs for current session',
            runsAcrossMachinesSubtitle: 'Runs across machines',
            resetVoiceAgentTitle: 'Reset voice agent',
            voiceSubtitle: 'Voice',
            signOutTitle: 'Sign Out',
            signOutSubtitle: 'Sign out of your account',
            developerMenuTitle: 'Developer Menu',
            developerMenuSubtitle: 'Access developer tools',
        },
    pets: {
      category: "ペット",
      wakeTitle: "ペットを起こす",
      wakeSubtitle: "このサーフェスにコンパニオンを表示します。",
      tuckTitle: "ペットをしまう",
      tuckSubtitle: "このサーフェスでコンパニオンを非表示にします。",
      resetPositionTitle: "ペットの位置をリセット",
      resetPositionSubtitle: "コンパニオンを既定の場所へ戻します。",
      chooseTitle: "ペットを選択",
      chooseSubtitle: "ペット設定を開きます。",
      refreshCodexTitle: "Codex ペットを更新",
      refreshCodexSubtitle: "設定を開き、ローカルの Codex ペットを検出します。",
    },
  },

  commandView: {
    completedWithNoOutput: "[出力なしでコマンドが完了しました]",
  },

  delegation: {
    output: {
      title: "委任",
      deliverablesTitle: "成果物",
    },
  },

  modelPickerOverlay: {
    refreshModelsA11y: "モデルを更新",
    loadingModelsA11y: "モデルを読み込み中…",
    refreshingModelsA11y: "モデルを更新中…",
    searchPlaceholder: "モデルを検索…",
    customTitle: "カスタム…",
    customInputA11y: "カスタムモデル識別子",
    optionControlA11y: ({ name }: { name: string }) => `モデルオプション: ${name}`,
    effectiveLabel: ({ label }: { label: string }) => `適用中: ${label}`,
  },

  voiceAssistant: {
    connecting: "接続中...",
    active: "音声アシスタントが有効です",
    connectionError: "接続エラー",
    label: "音声アシスタント",
    tapToEnd: "タップして終了",
    startDictation: "音声入力を開始",
    startVoice: "音声を開始",
    startGlobalVoice: "グローバル音声を開始",
    endVoice: "音声を終了",
    transcribing: "文字起こし中…",
    endDictation: "音声入力を終了",
  },

  voiceSurface: {
    reviewCredentials: '認証情報を確認',
    connectAgent: '接続',
    installAgentRuntime: 'インストール',
    updateAgentRuntime: '更新',
    start: "開始",
    stop: "停止",
    selectSessionToStart: "音声を開始するセッションを選択してください",
    targetSession: "ターゲットセッション",
    conversationalTranscriptUnavailable: "この音声セッションの会話トランスクリプトは利用できません",
    orbLabel: "音声",
    orbStartHint: "音声会話を開始します。上にスワイプすると会話が開きます。",
    orbEndHint: "音声会話を終了します。すでに始まったコーディング作業は続行されます。上にスワイプすると会話が開きます。",
    orbMinimiseHint: "音声を最小化します",
    orbExpand: "音声を展開",
    orbCollapse: "音声を折りたたむ",
    delegatedWorking: "作業中…",
    composerStartHint: "このセッションについて音声会話を開始します。",
    composerGlobalStartHint: "どのセッションにも紐づかない音声会話を開始します。",
    composerEndHint: "音声会話を終了します。すでに開始したコーディング作業は続行されます。",
    noTarget: "セッションが選択されていません",
    clearTarget: "ターゲットをクリア",
    a11y: {
      teleport: "音声エージェントをテレポート",
      toggleActivity: "音声アクティビティを切り替え",
      clearActivity: "音声アクティビティをクリア",
      bargeIn: "割り込み",
      cancelTurn: "応答をキャンセル",
      openConversation: "音声会話を開く",
      microphoneActive: "マイクは有効です",
      microphoneInactive: "マイクは無効です",
      microphoneMuted: "マイクはミュートされています",
      providerDataDisclosure: ({ provider }: { provider: string }) => `${provider} による音声データの取り扱い`,

      mute: "マイクをミュート",
      unmute: "マイクのミュートを解除",},
  },

  voiceActivity: {
    title: "音声アクティビティ",
    empty: "音声アクティビティはまだありません。",
    clear: "クリア",
    format: {
      voiceAgent: "音声エージェント",
      you: "あなた",
      assistant: "アシスタント",
      assistantStreaming: "アシスタント…",
      action: "アクション",
      error: "エラー",
      status: "状態",
      started: "開始",
      stopped: "停止",
      errorFallback: "エラー",
      eventFallback: "イベント",
    },
  },

  devVoiceQa: {
    menuTitle: "音声QAハーネス",
    menuSubtitle: "テキストプロンプトで実際の音声エージェントを操作",
    title: "音声QAハーネス",
    subtitle: "設定済みの音声ランタイムを起動し、マイクを使わずにプロンプトを送信します。",
    instructions: "この画面では、実際のローカル音声エージェントや ElevenLabs セッションを、再現可能なテキストプロンプトで検証できます。セッション ID を空のままにすると、現在の音声ターゲットまたはグローバル音声エージェントセッションが使われます。",
    configurationTitle: "設定",
    configuredProvider: "設定済みプロバイダー",
    qaProvider: "アクティブなQAプロバイダー",
    qaStatus: "QAステータス",
    targetSession: "現在の対象セッション",
    runtimeSession: "アクティブなランタイムセッション",
    inputsTitle: "入力",
    sessionIdLabel: "セッションID上書き",
    sessionIdPlaceholder: "空のままにすると現在の音声ターゲットを使用します",
    initialContextLabel: "初期コンテキスト",
    initialContextPlaceholder: "QA セッション開始時に送信する任意のコンテキスト",
    promptLabel: "プロンプト",
    promptPlaceholder: "音声エージェントに送信するテキストを入力",
    contextUpdateLabel: "コンテキスト更新",
    contextUpdatePlaceholder: "任意の追加入力コンテキスト",
    actionsTitle: "アクション",
    sendContext: "コンテキストを送信",
    usesCurrentProvider: "このハーネスは常に現在の音声設定と実際のランタイム統合を使用します。",
    localModeHint: "ローカル QA には、会話モードを Agent に設定した Local voice が必要です。",
    elevenLabsHint: "ElevenLabs QA には、ElevenLabs プロバイダーが設定済みで、リアルタイムセッションが正常に接続できることが必要です。",
    transcriptTitle: "QA 文字起こし",
    transcriptEmpty: "QA 文字起こしはまだありません。",
    activityTitle: "音声アクティビティ",
    activityEmpty: "現在の QA セッションでは、まだ音声アクティビティが記録されていません。",

    recordedAudio: {
      title: "録音音声 STT QA",
      uriLabel: "録音音声 URI",
      uriPlaceholder: "file:///recording.wav または Web ファイルを選択",
      daemonPackIdLabel: "daemon STT パック ID 上書き",
      daemonPackIdPlaceholder: "任意: 文字起こし前に local_neural daemon STT QA 設定を適用",
      daemonMachineIdLabel: "daemon マシン ID 上書き",
      daemonMachineIdPlaceholder: "任意: 録音音声セッション ID 用のマシンターゲットを設定",
      daemonBasePathLabel: "daemon ベースパス上書き",
      daemonBasePathPlaceholder: "任意: daemon STT 用のマシンベースパスを設定",
      chooseFile: "録音音声を選択",
      noFileSelected: "録音音声が選択されていません",
      transcribe: "録音音声を文字起こし",
      statusLabel: "ステータス",
      noResult: "文字起こし結果はありません",
    },},

  server: {
    // Used by Server Configuration screen (app/(app)/server.tsx)
    serverConfiguration: "Relay 設定",
    enterServerUrl: "Relay URLを入力してください",
    notValidHappyServer: "有効なHappier Relayではありません",
    changeServer: "Relayを変更",
    continueWithServer: "このRelayで続行しますか？",
    resetToDefault: "デフォルトにリセット",
    resetServerDefault: "Relayをデフォルトにリセットしますか？",
    validating: "検証中...",
    validatingServer: "Relayを検証中...",
    serverReturnedError: "Relayがエラーを返しました",
    failedToConnectToServer: "Relayへの接続に失敗しました",
    currentlyUsingCustomServer: "現在カスタムRelayを使用中",
    customServerUrlLabel: "カスタムRelay URL",
    advancedFeatureFooter:
      "これは高度な機能です。何をしているか理解している場合のみRelayを変更してください。Relay変更後は再度ログインが必要です。",
    useThisServer: "このRelayを使用",
    autoConfigHint:
      "セルフホストの場合: まずRelayを設定し、サインイン（またはアカウント作成）してから、ターミナルを接続してください。",
    renameServer: "Relay名を変更",
    renameServerPrompt: "このRelayの新しい名前を入力してください。",
    renameServerGroup: "Relayグループ名を変更",
    renameServerGroupPrompt:
      "このRelayグループの新しい名前を入力してください。",
    serverNamePlaceholder: "Relay名",
    cannotRenameCloud: "クラウドRelayの名前は変更できません。",
    removeServer: "Relayを削除",
    removeServerConfirm: ({ name }: { name: string }) =>
      `保存済みRelayから「${name}」を削除しますか？`,
    removeServerGroup: "Relayグループを削除",
    removeServerGroupConfirm: ({ name }: { name: string }) =>
      `保存済みRelayグループから「${name}」を削除しますか？`,
    cannotRemoveCloud: "クラウドRelayは削除できません。",
    signOutThisServer: "このRelayからもサインアウトしますか？",
    signOutThisServerPrompt:
      "この端末に、このRelayの保存済み認証情報が見つかりました。",
    savedServersTitle: "保存済み Relay",
    signedIn: "サインイン済み",
    signedOut: "サインアウト済み",
    authStatusUnknown: "認証状態が不明",
    switchToServer: "この Relay に切り替え",
    active: "アクティブ",
    default: "デフォルト",
    addServerTitle: "Relayを追加",
    switchForThisTab: "このタブのみ切り替え",
    makeDefaultOnDevice: "この端末のデフォルトにする",
    serverNameLabel: "Relay名",
    addAndUse: "追加して使用",
      addTargetsTitle: "追加",
      addServerSubtitle: "新しいRelayを追加して切り替え",
      notificationAddServerHint: "このRelayはまだこの端末に保存されていません。続行するには下で追加してください。",
      serverCount: ({ count }: { count: number }) => `${count} Relay`,
      useCanonicalServerUrlTitle: "正規のRelay URLを使用しますか？",
    useCanonicalServerUrlBody:
      "このRelayは他の端末からも使える正規のURLを案内しています。入力したURLの代わりにこちらを使用しますか？",
    insecureHttpUrlTitle: "安全でないRelay URL",
    insecureHttpUrlBody:
      "このURLは http:// を使用しており、スマホやLAN外からは動作しない可能性があります。可能であればHTTPSを使用してください。それでも続行しますか？",
    signedOutSwitchConfirmTitle: "接続されていません",
    signedOutSwitchConfirmBody:
      "このRelayに切り替えてホーム画面へ進み、サインインまたはアカウント作成を行いますか？",
    addServerGroupTitle: "Relayグループを追加",
    addServerGroupSubtitle: "再利用可能なRelayのグループを作成",
    serverGroupNameLabel: "グループ名",
    serverGroupNamePlaceholder: "自分のRelayグループ",
    serverGroupServersLabel: "Relay",
    saveServerGroup: "グループを保存",
    serverGroupMustHaveServer:
      "Relayグループには少なくとも1つのRelayが必要です。",
    relayDrift: {
        bannerDifferentRelayTitle: 'バックグラウンドサービスが別の Relay に接続されています',
        bannerDifferentRelayDescription: ({ activeRelayUrl, daemonRelayUrl }: { activeRelayUrl: string; daemonRelayUrl: string }) => `アプリ: ${activeRelayUrl} · バックグラウンドサービス: ${daemonRelayUrl}`,
        bannerNeedsAuthTitle: 'バックグラウンドサービスがこの Relay にサインインする必要があります',
        bannerNeedsAuthDescription: ({ activeRelayUrl }: { activeRelayUrl: string }) => `アプリは ${activeRelayUrl} を使用していますが、バックグラウンドサービスにはまだ承認またはサインインが必要です。`,
        bannerNotConfiguredTitle: 'バックグラウンドサービスはまだこの Relay に接続されていません',
        bannerNotConfiguredDescription: ({ activeRelayUrl }: { activeRelayUrl: string }) => `アプリは ${activeRelayUrl} を使用していますが、このコンピューターではまだバックグラウンドサービスの接続が完了していません。`,
        bannerNotInstalledTitle: 'この Relay 用のバックグラウンドサービスがインストールされていません',
        bannerNotInstalledDescription: ({ activeRelayUrl }: { activeRelayUrl: string }) =>
            `アプリは ${activeRelayUrl} を使用していますが、このコンピューターにはまだバックグラウンドサービスのインストールが必要です。`,
        bannerNotRunningTitle: 'バックグラウンドサービスはインストール済みですが実行されていません',
        bannerNotRunningDescription: ({ activeRelayUrl }: { activeRelayUrl: string }) =>
            `アプリは ${activeRelayUrl} を使用していますが、バックグラウンドサービスは停止しており、再起動が必要です。`,
        repairAction: 'バックグラウンドサービスをこの Relay に接続',
        progressTitle: 'バックグラウンドサービスをこのRelayに接続しています',
        progressStepPrepare: 'バックグラウンドサービスを準備',
        progressStepConfigureRelay: 'Relay 接続を更新',
        progressStepAuthenticate: 'サインインと承認を完了',
        progressStepFinish: '修復を完了',
        statusUnknown: '不明',
    },
    retention: {
      title: "保持ポリシー",
      summary: "概要",
      keepForever: "自動削除なし",
      automaticDeletionEnabled: "自動削除が有効です",
      detailsUnavailable: "自動削除は有効ですが、このクライアントでは有効なポリシーをすべて表示できません",
      singlePolicySummary: ({ domain, policy }: { domain: string; policy: string }) => `${domain}: ${policy}`,
      relayCleanupSummary: ({ policies }: { policies: string }) => `このリレーは${policies}をクリーンアップします。`,
      relayCleanupAfterDays: ({ domain, count }: { domain: string; count: number }) => `${domain}（${count}日後）`,
      relayCleanupInactiveSessionsAfterDays: ({ count }: { count: number }) => `非アクティブなセッション（${count}日後）`,
      deleteInactiveSessionsDays: ({ count }: { count: number }) => `${count}日後に非アクティブなセッションを削除します。`,
      deleteOlderThanDays: ({ count }: { count: number }) => `${count}日後にデータを削除します。`,
      sessionNotice: ({ count }: { count: number }) => `このサーバーは、${count}日間非アクティブなセッションを削除します。`,
      sessions: "セッション",
      sidechainMessages: "サブエージェントの記録",
      usageEvents: "使用状況イベント",
      accountChanges: "アカウント変更",
      voiceSessionLeases: "音声セッションのリース",
      feedItems: "フィード項目",
      sessionShareAccessLogs: "共有セッションのアクセスログ",
      publicShareAccessLogs: "公開共有のアクセスログ",
      terminalAuthRequests: "ターミナル認証リクエスト",
      accountAuthRequests: "アカウント認証リクエスト",
      authPairingSessions: "認証ペアリングセッション",
      repeatKeys: "リピートキー",
      globalLocks: "グローバルロック",
      automationRuns: "自動化の実行",
      automationRunEvents: "自動化実行イベント",
    },
    multiServerView: {
      title: "複数Relay同時表示",
      footer: "複数のRelayを 1 つのセッション一覧にまとめるか選択します。",
      enableTitle: "同時表示を有効化",
      enableSubtitle: "選択したRelayのセッションをまとめて表示します",
      presentationTitle: "表示モード",
      presentation: {
        flatWithBadges: "Relayバッジ付きのフラット一覧",
        groupedByServer: "Relayごとにグループ化",
      },
    },

    reachabilityRemediation: {
      failedToOpenInstallLink: "Tailscale のインストールページを開けませんでした。",
      tailscale: {
        title: "この Relay は Tailscale を使っています",
        desktopBody: "このコンピューターは Tailscale 経由で Relay に接続できませんでした。このコンピューターで Tailscale が未インストール、未サインイン、または正しい tailnet に接続されていない可能性があります。",
        webBody: "このブラウザーは Tailscale 経由で Relay に接続できませんでした。この端末で Tailscale を開き、正しい tailnet に接続されていることを確認してから再試行してください。",
        nativeBody: "この端末は Tailscale 経由で Relay に接続できませんでした。Tailscale を開き、正しい tailnet に接続されていることを確認してから再試行してください。",
        installAction: "Tailscale をインストール",
        desktopPrepareAction: "Tailscale を準備",
      },
    },},

  sessionTags: {
    searchOrAddPlaceholder: "タグを検索または追加",
    editTagsLabel: "タグを編集",
    noTagsFound: "タグが見つかりません",
    newTagItem: "新しいタグ…",
    newTagTitle: "新しいタグ",
    newTagMessage: "新しいタグ名を入力してください。",
    newTagConfirm: "追加",
  },

  sessionsList: {
    serverHeader: ({ server }: { server: string }) => `サーバー: ${server}`,
    storagePersistedTab: "Happier",
    storageAllFilter: "すべて",
    storageFilterCategory: "セッション",
    storageExternalFilter: "外部",
    storageDirectTab: "ダイレクト",
    renameWorkspace: 'ワークスペース名を変更',
    renameWorkspacePromptTitle: 'ワークスペース名を変更',
    renameWorkspacePromptPlaceholder: '名前を入力...',
    resetWorkspaceName: '名前をリセット',
    viewOptions: '表示オプション',
    searchSessions: 'セッションを検索',
    searchSessionsPlaceholder: 'セッションを検索...',
    filterByTags: 'タグで絞り込み',
    folders: 'フォルダー',
    addFolder: 'フォルダーを追加',
    addFolderPromptTitle: 'フォルダーを追加',
    addSubfolder: 'サブフォルダーを追加',
    addSubfolderPromptTitle: 'サブフォルダーを追加',
    folderNamePlaceholder: 'フォルダー名',
    renameFolder: 'フォルダー名を変更',
    renameFolderPromptTitle: 'フォルダー名を変更',
    moveFolder: 'フォルダーを移動',
    deleteFolder: 'フォルダーを削除',
    deleteFolderPromptTitle: 'フォルダーを削除',
    deleteFolderPromptDescription: 'このフォルダー内のセッションはワークスペースに残ります。',
    newSessionInFolder: 'フォルダーで新規セッション',
    clearFolderFocus: 'フォルダーのフォーカスを解除',
    folderViewTree: 'フォルダー表示',
    folderViewOff: 'フォルダーを非表示',
    moveToFolder: 'フォルダーへ移動',
    moveToWorkspaceRoot: 'ワークスペースのルート',
    sessionFallbackLabel: 'Session',
    moveSheetTitle: ({ item }: { item: string }) => 'Move ' + item,
    moveSheetDestinationLabel: 'Destination',
    moveSheetSubmit: 'Move',
    moveSheetSearchPlaceholder: 'Search folders...',
    moveSheetEmpty: 'No move targets available',
    moveSheetDestinations: 'Destinations',
    moveSheetDisabledDescendant: 'Cannot move into itself or a child folder.',
    moveSheetDisabledMaxDepth: 'This would exceed the folder depth limit.',
    moveSheetDisabledCurrent: 'Already in this location.',
    moveSheetDisabledUnavailable: 'This destination is not available.',
    dragHandleA11yLabel: 'Drag handle',
    dragA11yPickedUp: ({ item }: { item: string }) => 'Picked up ' + item + '.',
    dragA11yDroppedReorder: ({ item, destination }: { item: string; destination: string }) => 'Moved ' + item + ' near ' + destination + '.',
    dragA11yDroppedNest: ({ item, destination }: { item: string; destination: string }) => 'Moved ' + item + ' into ' + destination + '.',
    dragA11yDroppedRoot: ({ item, destination }: { item: string; destination: string }) => 'Moved ' + item + ' to ' + destination + '.',
    dragA11yCancelled: ({ item }: { item: string }) => 'Move cancelled for ' + item + '.',
    dragA11yBlocked: ({ item, reason }: { item: string; reason: string }) => 'Could not move ' + item + ': ' + reason,
    dragA11yBlockedDescendantCycle: 'destination is inside the moved folder',
    dragA11yBlockedLeafCannotBeParent: 'sessions cannot contain other items',
    dragA11yBlockedMaxDepth: 'folder depth limit reached',
    dragA11yBlockedSamePosition: 'already in that position',
    dragA11yBlockedWorkspaceScope: 'destination is in another workspace',
    dragA11yBlockedNoTarget: 'no destination selected',
    dragA11yBlockedDirectSession: 'direct sessions cannot be moved to folders',
    dragA11yBlockedFeatureDisabled: 'session folders are not enabled',
    dragA11yBlockedUnsupportedItem: 'this item cannot be moved to folders',
    hideInactiveSessions: '非アクティブなセッションを非表示',
    showInactiveSessions: '非アクティブなセッションを表示',
    attentionSectionTitle: '確認が必要',
    workingSectionTitle: '処理中',
        backgroundWorkingSectionTitle: 'バックグラウンドで実行中',
    selectionSelectedCount: ({ count }: { count: number }) => count === 1 ? '1 session selected' : `${count} sessions selected`,
    selectionA11ySelectedCount: ({ count }: { count: number }) => count === 1 ? '1 session selected' : `${count} sessions selected`,
    selectionCheckboxA11yLabel: 'Select session',
    selectionSelectAction: 'Select',
    selectionSelectAllVisible: 'Select all',
    selectionSelectAllVisibleA11yLabel: '表示中のすべてのセッションを選択',
    selectionMoveSheetSourceLabel: ({ count }: { count: number }) => count === 1 ? '1 selected session' : `${count} selected sessions`,
    selectionAddTags: 'タグを追加',
    selectionRemoveTags: 'タグを削除',
    selectionSetTags: 'タグを設定',
    selectionAddTagsPromptTitle: 'タグを追加',
    selectionRemoveTagsPromptTitle: 'タグを削除',
    selectionSetTagsPromptTitle: 'タグを設定',
    selectionTagsPromptMessage: 'タグをカンマで区切って入力してください。',
    selectionTagsPlaceholder: 'タグ1, タグ2',
    selectionCancelA11yLabel: 'セッション選択をキャンセル',
    selectionProgress: ({ completed, total }: { completed: number; total: number }) => `${completed} of ${total} complete`,
    selectionCancelRunningA11yLabel: '選択したセッションの操作をキャンセル',
    selectionResult: ({ succeeded, failed, skipped }: { succeeded: number; failed: number; skipped: number }) => `${succeeded} succeeded, ${failed} failed, ${skipped} skipped`,
    selectionDismissResultA11yLabel: '選択したセッション操作の結果を閉じる',
    selectionConfirm: ({ action, count }: { action: string; count: number }) => `${action} ${count} selected ${count === 1 ? 'session' : 'sessions'}?`,
    selectionConfirmA11yLabel: ({ action }: { action: string }) => `Confirm ${action}`,

    emptyState: {
      title: "セッションはまだありません",
      description: "オンラインのマシンのいずれかでセッションを開始します。",
      descriptionPrefix: "お使いのマシンのいずれかで ",
      descriptionSuffix: " をターミナルで使うか、下のボタンから開始してください。",
      actionsTitle: "セッションを開始",
      startSessionOnMachine: ({ machine }: { machine: string }) => `${machine} でセッションを開始`,
      startSessionOnMachineSubtitle: "フォルダーを選んで、このマシンで新しいセッションを開きます。",
      reconnectMachineActionSubtitle: "このマシンで再びセッションを開始できるように、バックグラウンドサービスを再接続します。",
      startDaemonActionSubtitle: "セッション開始に必要なバックグラウンドサービスをインストールまたは再起動します。",
    },
    openProject: 'プロジェクトを開く',
    workspaceRoot: "ワークスペースのルート",
    failedToMoveSessionToFolder: "セッションをフォルダーに移動できませんでした。",
    newFolderDefaultName: "新しいフォルダー",},

  directSessions: {
    browseTitle: "外部セッションを参照",
    browseOpenExisting: "外部セッションを参照",
    browseActionSubtitle: "ここで開くマシン、エージェント、セッションを選択します。",
    browseFiltersTitle: "ソースを選択",
    browseMachines: "マシン",
    browseAgents: "エージェント",
    browseSources: "ソース",
    browseSourceCodexUserHome: "自分の Codex ホーム",
    browseSourceCodexConnectedServices: ({ service }: { service: string }) => `${service} の接続済みサービス`,
    browseSourceClaudeDefault: "デフォルトの Claude 設定",
    browseSourceOpenCodeDefault: "デフォルトの OpenCode サーバー",
    browseCandidates: "利用可能なセッション",
    browseNoMachines: "直接セッションに利用できるマシンはまだありません。",
    browseNoCandidates: "このマシンとエージェントに対する外部セッションは見つかりませんでした。",
    browseActivityRunning: "実行中",
        browseActivityRunningNow: "実行中",
    browseActivityRecent: "最近アクティブ",
    browseActivityIdle: "アイドル",
    browseActivityUnknown: "不明",
        browseSearchPlaceholder: "セッションを検索…",
        browseNoSearchResults: "この検索に一致するセッションはまだありません。",
    browseLoadMore: "さらにセッションを読み込む",
    browseFailedToLoad: "外部セッションの読み込みに失敗しました。",
    browseLinkFailed: "選択した外部セッションのリンクに失敗しました。",
  },

    workspacePresentation: {
        checkoutKinds: {
            primary: "主要チェックアウト",
            git_worktree: "Git ワークツリー",
        },
    },
    sourceControlWorkspace: {
        createTitle: 'リンク済みワークスペースを作成',
        createSubtitle: "このチェックアウトをリンク済みワークスペースに追加して設定を開きます。",
        otherCheckoutsTitle: "その他のチェックアウト",
        unlinkedWorktreesTitle: "未リンクのワークツリー",
        createSessionInWorktreeTitle: 'ここでセッションを作成',
        adoptWorktreeTitle: "ワークツリーをワークスペースに追加",
    },

	  sessionInfo: {
	    // Used by Session Info screen (app/(app)/session/[id]/info.tsx)
	    title: "セッション情報",
	    killSession: "セッションを終了",
    killSessionConfirm: "このセッションを終了してもよろしいですか？",
    stopSession: "セッションを停止",
    stopSessionConfirm: "このセッションを停止してもよろしいですか？",
    archiveSession: "セッションをアーカイブ",
    archiveSessionConfirm: "このセッションをアーカイブしてもよろしいですか？",
    workspaceTitle: "ワークスペース",
    workspaceLabel: "ワークスペース",
    linkWorkspaceTitle: "このワークスペースをリンク",
    linkWorkspaceSubtitle: "このセッションのパスからリンク済みワークスペースを作成し、その設定を開きます。",
    openWorkspaceTitle: "ワークスペースを開く",
    openWorkspaceSubtitle: "リンク済みワークスペースの詳細と設定を開きます。",
    createWorktreeTitle: "worktree を作成",
    createWorktreeSubtitle: "このリンク済みワークスペースで Git worktree を作成する新しいセッションを開始します。",
    locationLabel: "場所",
    checkoutLabel: "チェックアウト",
    happySessionIdCopied:
      "Happier セッション ID をクリップボードにコピーしました",
    failedToCopySessionId: "Happier セッション ID のコピーに失敗しました",
    happySessionId: "Happier セッション ID",
    claudeCodeSessionId: "Claude Code セッション ID",
    claudeCodeSessionIdCopied:
      "Claude Code セッション ID をクリップボードにコピーしました",
    aiProfile: "AIプロファイル",
    aiProvider: "AIプロバイダー",
    failedToCopyClaudeCodeSessionId:
      "Claude Code セッション ID のコピーに失敗しました",
    codexSessionId: "Codex セッション ID",
    codexSessionIdCopied:
      "Codex セッション ID をクリップボードにコピーしました",
    failedToCopyCodexSessionId: "Codex セッション ID のコピーに失敗しました",
    opencodeSessionId: "OpenCode セッション ID",
    opencodeSessionIdCopied:
      "OpenCode セッション ID をクリップボードにコピーしました",
    auggieSessionId: "Auggie セッション ID",
    auggieSessionIdCopied:
      "Auggie セッション ID をクリップボードにコピーしました",
    geminiSessionId: "Gemini セッション ID",
    geminiSessionIdCopied:
      "Gemini セッション ID をクリップボードにコピーしました",
    qwenSessionId: "Qwen Code セッション ID",
    qwenSessionIdCopied:
      "Qwen Code セッション ID をクリップボードにコピーしました",
    kimiSessionId: "Kimi セッション ID",
    kimiSessionIdCopied: "Kimi セッション ID をクリップボードにコピーしました",
    kiloSessionId: "Kilo セッション ID",
    kiloSessionIdCopied: "Kilo セッション ID をクリップボードにコピーしました",
    kiroSessionId: "Kiro セッション ID",
    kiroSessionIdCopied: "Kiro セッション ID をクリップボードにコピーしました",
    customAcpSessionId: "カスタム ACP セッション ID",
    customAcpSessionIdCopied: "カスタム ACP セッション ID をクリップボードにコピーしました",
    piSessionId: "Pi セッション ID",
    piSessionIdCopied: "Pi セッション ID をクリップボードにコピーしました",
    copilotSessionId: "Copilot セッション ID",
    copilotSessionIdCopied:
      "Copilot セッション ID をクリップボードにコピーしました",
    cursorSessionId: "Cursor セッション ID",
    cursorSessionIdCopied:
      "Cursor セッション ID をクリップボードにコピーしました",
    metadataCopied: "メタデータがクリップボードにコピーされました",
    failedToCopyMetadata: "メタデータのコピーに失敗しました",
    copyDebugInformation: "情報をコピー",
    debugInformationCopyLabel: "情報",
    providerSessionLogs: ({ provider }: { provider: string }) => `${provider} セッションログ`,
    failedToKillSession: "セッションの終了に失敗しました",
    failedToStopSession: "セッションの停止に失敗しました",
    failedToArchiveSession: "セッションのアーカイブに失敗しました",
    connectionStatus: "接続状態",
    created: "作成日時",
    lastUpdated: "最終更新",
    sequence: "シーケンス",
    quickActions: "クイックアクション",
    markSessionRead: "既読にする",
    markSessionReadSubtitle: "このセッションの未読表示を解除",
    markSessionUnread: "未読にする",
    markSessionUnreadSubtitle: "このセッションを未読リストに残します",
    executionRunsSubtitle: "このセッションの実行を表示",
    automationsTitle: "オートメーション",
    automationsSubtitle: "このセッションのスケジュール済みメッセージを管理",
    viewSessionLogTitle: "セッションログを表示",
    viewSessionLogSubtitle: "このセッションのライブログ末尾を開く",
    pinSession: "セッションをピン留め",
    unpinSession: "ピン留め解除",
    copyResumeCommand: "再開コマンドをコピー",
    resumeCommand: ({ sessionId }: { sessionId: string }) => `happier resume ${sessionId}`,
    viewMachine: "マシンを表示",
    viewMachineSubtitle: "マシンの詳細とセッションを表示",
    killSessionSubtitle: "セッションを即座に終了",
    stopSessionSubtitle: "セッションプロセスを停止",
    archiveSessionSubtitle: "このセッションをアーカイブへ移動",
    archivedSessions: "アーカイブ済みセッション",
    inactiveAndArchivedSessions: "非アクティブとアーカイブ済みのセッション",
    unarchiveSession: "アーカイブ解除",
    unarchiveSessionConfirm: "このセッションのアーカイブを解除してもよろしいですか？",
    unarchiveSessionSubtitle: "このセッションを非アクティブに戻す",
    failedToUnarchiveSession: "セッションのアーカイブ解除に失敗しました",
    metadata: "メタデータ",
    host: "ホスト",
    path: "パス",
    operatingSystem: "オペレーティングシステム",
    processId: "プロセスID",
    happyHome: "Happier のホーム",
    attachFromTerminal: "ターミナルからアタッチ",
    tmuxTarget: "tmux ターゲット",
    tmuxFallback: "tmux フォールバック",
    copyMetadata: "メタデータをコピー",
    agentState: "エージェント状態",
    rawJsonDevMode: "生JSON（開発者モード）",
    sessionStatus: "セッションステータス",
    fullSessionObject: "セッションオブジェクト全体",
    controlledByUser: "ユーザーによる制御",
    pendingRequests: "保留中のリクエスト",
    activity: "アクティビティ",
    thinking: "思考中",
    thinkingSince: "思考開始時刻",
    thinkingLevel: "思考レベル",
    cliVersion: "CLIバージョン",
    cliVersionOutdated: "CLIの更新が必要",
    cliVersionOutdatedMessage: ({
      currentVersion,
      requiredVersion,
    }: {
      currentVersion: string;
      requiredVersion: string;
    }) =>
      `バージョン ${currentVersion} がインストールされています。${requiredVersion} 以降に更新してください`,
    updateCliInstructions:
      "happier self update を実行してください",
    deleteSession: "セッションを削除",
    deleteSessionSubtitle: "このセッションを完全に削除",
    deleteSessionConfirm: "セッションを完全に削除しますか？",
    deleteSessionWarning:
      "この操作は取り消せません。このセッションに関連するすべてのメッセージとデータが完全に削除されます。",
    failedToDeleteSession: "セッションの削除に失敗しました",
    sessionDeleted: "セッションが正常に削除されました",
    manageSharing: "共有を管理",
    manageSharingSubtitle: "友達とセッションを共有するか、公開リンクを作成",
    renameSession: "セッション名を変更",
    renameSessionSubtitle: "このセッションの表示名を変更します",
    renameSessionPlaceholder: "セッション名を入力...",
    forkSession: "セッションを分岐",
    forkSessionSubtitle: "最新のコンテキストから新しいセッションを作成します",
    newSessionSameSetup: "同じ設定で新しいセッション",
    newSessionSameSetupSubtitle: "このセッションのマシン、フォルダ、エンジン、モデル、セッションオプションを再利用します。",
    failedToRenameSession: "セッション名の変更に失敗しました",
    failedToMarkSessionRead: "セッションを既読にできませんでした",
    failedToMarkSessionUnread: "セッションを未読にできませんでした",
    sessionRenamed: "セッション名を変更しました",

	    openInSplitRight: "右分割で開く",
	    openInSplitDown: "下分割で開く",
	    revealInCurrentSplit: "現在の分割で表示",},

  components: {
    emptyMainScreen: {
      // Used by SessionGettingStartedGuidance component
      readyToCode: "コーディングを始めますか？",
      installCli: "Happier CLIをインストール",
      runIt: "実行する",
      scanQrCode: "QRコードをスキャン",
      openCamera: "カメラを開く",
      runCommand: "$ happier",
    },
    emptyMessages: {
      noMessagesYet: "まだメッセージはありません",
      created: ({ time }: { time: string }) => `作成 ${time}`,
    },
    emptySessionsTablet: {
      noActiveSessions: "アクティブなセッションはありません",
      startNewSessionDescription:
        "接続済みのどのマシンでも新しいセッションを開始できます。",
      startNewSessionButton: "新しいセッションを開始",
      openTerminalToStart:
        "セッションを開始するには、コンピュータで新しいターミナルを開いてください。",
    },
  },

  zen: {
    title: "Zen",
    add: {
      placeholder: "やることは？",
    },
    home: {
      noTasksYet: "まだタスクはありません。+ をタップして追加します。",
    },
    view: {
      workOnTask: "タスクに取り組む",
      clarify: "明確化",
      delete: "削除",
      linkedSessions: "リンクされたセッション",
      tapTaskTextToEdit: "タスクのテキストをタップして編集",
    },
  },

  agentInput: {
      chipPicker: {
          selectedOptionAccessibilityLabel: ({ option }: { option: string }) => `${option}。選択中。`,
      },
    suggestionGroups: {
      files: 'ファイル',
      plugins: 'プラグイン',
      sessions: 'セッション',
      references: '参照',
      skills: 'スキル',
      commands: 'コマンド',
    },
    stopCodingTurn: "コーディングターンを停止",
      nonSteerableSend: {
        title: 'エージェントは処理中です',
        modeChangeMessage: '権限モードの変更は実行中のターンには適用できません。',
        providerConfigMessage: 'このプロバイダー設定の変更は実行中のターンには適用できません。',
        specialCommandMessage: 'このコマンドはアクティブなターン中には実行できません。',
        interruptAndSend: '中断して今すぐ送信',
        applySettingAndSteer: '設定を適用して今すぐ送信',
        applyNamedSettingAndSteer: ({ setting, value }: { setting: string; value: string }) => `${setting} → ${value} を適用して今すぐ送信`,
        steerWithoutApplying: '適用せずに今すぐ送信（次のメッセージで適用）',
        queueForAfterTurn: 'ターン終了後にキューへ',
      },
    dropToAttach: "ドロップして添付",
    providerUsage: {
      title: "プロバイダー使用量",
      accessibilityLabel: ({ value }: { value: string }) =>
        `プロバイダー使用量: 残り ${value}`,
      remaining: ({ percent }: { percent: string }) => `残り ${percent}`,
      remainingWithReset: ({ percent, reset }: { percent: string; reset: string }) =>
        `残り ${percent} · ${reset} 後にリセット`,
      usedCount: ({ used, limit }: { used: string; limit: string }) =>
        `${used}/${limit} 使用済み`,
      duration: {
        now: "今",
        outdated: '更新が必要',
        daysHours: ({ days, hours }: { days: number; hours: number }) =>
          `${days}日 ${hours}時間`,
        hoursMinutes: ({ hours, minutes }: { hours: number; minutes: number }) =>
          `${hours}時間 ${minutes}分`,
        hours: ({ hours }: { hours: number }) => `${hours}時間`,
        minutes: ({ minutes }: { minutes: number }) => `${minutes}分`,
      },
    },
    envVars: {
      title: "環境変数",
      titleWithCount: ({ count }: { count: number }) => `環境変数 (${count})`,
    },
    resumeChip: {
      withId: ({ title, id }: { title: string; id: string }) =>
        `${title}: ${id}`,
      withIdTruncated: ({
        title,
        prefix,
        suffix,
      }: {
        title: string;
        prefix: string;
        suffix: string;
      }) => `${title}: ${prefix}…${suffix}`,
    },
    permissionMode: {
      title: "権限モード",
      effectiveLabel: ({ label }: { label: string }) => `適用中: ${label}`,
      default: "デフォルト",
      readOnly: "読み取り専用",
      acceptEdits: "編集を許可",
      safeYolo: "オート",
      yolo: "YOLO",
      plan: "プランモード",
      bypassPermissions: "Yoloモード",
      badgeAccept: "許可",
      badgePlan: "プラン",
      badgeReadOnly: "読み取り専用",
      badgeSafeYolo: "オート",
      badgeYolo: "YOLO",
      badgeAcceptAllEdits: "すべての編集を許可",
      badgeBypassAllPermissions: "すべての権限をバイパス",
      badgePlanMode: "プランモード",
    },
    agent: {
      claude: "Claude",
      codex: "Codex",
      cursor: "Cursor",
      opencode: "OpenCode",
      antigravity: "Antigravity",
      gemini: "Gemini",
      auggie: "Auggie",
      qwen: "Qwen Code",
      kimi: "Kimi",
      kilo: "Kilo",
      kiro: "Kiro",
      customAcp: "カスタム ACP",
      pi: "Pi",
      copilot: "Copilot",

      ohMyPi: "oh-my-pi",},
    auggieIndexingChip: {
      on: "インデックス有効",
      off: "インデックス無効",
    },
    model: {
      title: "モデル",
      useCliSettings: "CLI設定を使用",
      running: ({ model }: { model: string }) => `実行中: ${model}`,
      lastUsed: ({ model }: { model: string }) => `前回使用: ${model}`,
      lastReported: ({ model }: { model: string }) => `最終報告: ${model}`,
      applyTimingNextMessage: "次のメッセージから適用されます",
      applyTimingNewSession: "新しいセッションを開始したときに適用されます",
      selectedForResume: "このセッションを再開すると、選択したモデルが使用されます。",
      configureInCli: "CLIの設定でモデルを構成",
      unavailable: "このマシンでは、このプロバイダーのモデル検出を利用できません。",
      extendedContextToggleLabel: "100万トークンのコンテキスト",
      extendedContextToggleDescription: "このモデルで拡張された100万トークンのコンテキストウィンドウを使用します。",
      customDescription: "一覧にないモデルIDを使用します。",
      customPromptBody: "モデルIDを入力してください",
      customPlaceholder: "例: claude-3.5-sonnet",
    },
    codexPermissionMode: {
      title: "権限モード",
      default: "CLI設定",
      plan: "プランモード",
      readOnly: "読み取り専用モード",
      safeYolo: "オート",
      yolo: "YOLO",
      badgePlan: "プラン",
      badgeReadOnly: "読み取り専用モード",
      badgeSafeYolo: "オート",
      badgeYolo: "YOLO",
    },
    codexModel: {
      title: "CODEXモデル",
      gpt5CodexLow: "gpt-5-codex 低",
      gpt5CodexMedium: "gpt-5-codex 中",
      gpt5CodexHigh: "gpt-5-codex 高",
      gpt5Minimal: "GPT-5 最小",
      gpt5Low: "GPT-5 低",
      gpt5Medium: "GPT-5 中",
      gpt5High: "GPT-5 高",
    },
    geminiPermissionMode: {
      title: "GEMINI権限モード",
      default: "デフォルト",
      readOnly: "読み取り専用モード",
      safeYolo: "セーフYOLO",
      yolo: "YOLO",
      badgeReadOnly: "読み取り専用モード",
      badgeSafeYolo: "セーフYOLO",
      badgeYolo: "YOLO",
    },
    geminiModel: {
      title: "GEMINIモデル",
      gemini25Pro: {
        label: "Gemini 2.5 Pro",
        description: "最高性能",
      },
      gemini25Flash: {
        label: "Gemini 2.5 Flash",
        description: "高速・効率的",
      },
      gemini25FlashLite: {
        label: "Gemini 2.5 Flash Lite",
        description: "最速",
      },
    },
    context: {
      remaining: ({ percent }: { percent: number }) => `残り ${percent}%`,
      windowTitle: "コンテキストウィンドウ",
      usedDetail: ({
        percent,
        used,
        total,
      }: {
        percent: string;
        used: string;
        total: string;
      }) => `${percent} • ${used}/${total} のコンテキストを使用`,
      description: "必要に応じてコンテキストを自動的に圧縮します。",
    },
    suggestion: {
      fileLabel: "ファイル",
      folderLabel: "フォルダ",
    },
    mode: {
      sectionTitle: "モード",
      badge: ({ name }: { name: string }) => `モード: ${name}`,
      badgePending: ({ name }: { name: string }) => `モード: ${name} (保留中)`,
      refreshModesA11y: "モードを更新",
      pendingSwitching: ({ from, to }: { from: string; to: string }) =>
        `保留中: ${from} から ${to} に切り替え中`,
      currentMode: ({ name }: { name: string }) => `現在: ${name}`,
      loadingModes: "モードを読み込み中…",
      refreshingModes: "モードを更新中…",
      useDefaultModeHint: "このエージェントのデフォルトモードを使用します。",
      startIn: ({ name }: { name: string }) => `開始: ${name}`,
      build: "ビルド",
      buildDescription: "デフォルトの動作",
      plan: "プラン",
      planDescription: "最初に考える",
    },
    acp: {
      modeSectionTitle: "モード",
      refreshModesA11y: "モードを更新",
      pendingSwitching: ({ from, to }: { from: string; to: string }) =>
        `保留中: ${from} から ${to} に切り替え中`,
      currentMode: ({ name }: { name: string }) => `現在: ${name}`,
      loadingModes: "モードを読み込み中…",
      refreshingModes: "モードを更新中…",
      useDefaultModeHint: "このエージェントのデフォルトモードを使用します。",
      startIn: ({ name }: { name: string }) => `開始: ${name}`,
      optionsSectionTitle: "オプション",
      optionsUnavailable: "このマシンでは、このプロバイダーの構成オプションを利用できません。",
      currentValue: ({ value }: { value: string }) => `現在: ${value}`,
      optionOverriddenBy: ({ name }: { name: string }) => `${name}により上書きされています`,
      pendingValue: ({
        current,
        requested,
      }: {
        current: string;
        requested: string;
      }) => `保留中: ${current} → ${requested}`,
    },
    actionMenu: {
      title: "操作",
      files: "ファイル",
      stop: "停止",
    },
    noMachinesAvailable: "マシンなし",
  },

  machineLauncher: {
    showLess: "折りたたむ",
    showAll: ({ count }: { count: number }) => `すべて表示 (${count}パス)`,
    enterCustomPath: "カスタムパスを入力",
    offlineUnableToSpawn: "オフラインのため新しいセッションを生成できません",
  },

  sidebar: {
    sessionsTitle: "Happier",
  },

  toolView: {
    open: "詳細を開く",
    expand: "展開/折りたたみ",
    input: "入力",
    output: "出力",
    showFullContent: "全文を表示",
    showLessContent: "表示を減らす",
  },

  tools: {
    common: {
      more: ({ count }: { count: number }) => `+${count} 件`,
      elapsedSeconds: ({ seconds }: { seconds: string }) => `${seconds}s`,
      unknownToolTitle: "ツール",
    },
    bashView: {
      commandDiffTitle: "生のコマンド",
      commandDiffHint:
        "読みやすくするため、コマンドのプレビューでは短い環境クリーンアップの接頭辞を隠しています。完全な生のコマンドは下に表示されます。",
    },
    webFetch: {
      httpStatus: ({ status }: { status: number }) => `HTTP ${status}`,
    },
    fullView: {
      description: "説明",
      inputParams: "入力パラメータ",
      output: "出力",
      error: "エラー",
      completed: "ツールが正常に完了しました",
      noOutput: "出力がありません",
      running: "ツールを実行中...",
      debug: "デバッグ",
      show: "表示",
      hide: "非表示",
      rawJsonDevMode: "Raw JSON (開発モード)",
    },
    agentTeamView: {
      team: "チーム",
      member: "メンバー",
      type: "種類",
      content: "内容",
      status: "状態",
      description: "説明",
    },
    workflowView: {
      title: "タイトル",
      description: "説明",
      status: "状態",
      summary: "要約",
      run: "実行",
      task: "タスク",
      toolUse: "ツール使用",
    },
    workflowActivityView: {
        untitled: "ワークフロー",
        loading: "読み込み中…",
        unavailable: "詳細を取得できません",
        noDetail: "これ以上の詳細はありません",
        statusActive: "実行中",
        statusComplete: "完了",
      statusFailed: "失敗",
      statusStopped: "停止",
      statusInterrupted: "中断",
      statusBlocked: "ブロック",
        statusCancelled: "キャンセル",
        statusUnknown: "不明",
        phaseUntitled: "フェーズ",
        phaseActivity: "アクティビティ",
        phaseComplete: ({ complete, total }: { complete: number; total: number }) => `${complete}/${total} 完了`,
        phaseActive: ({ count }: { count: number }) => `${count} アクティブ`,
        phaseFailed: ({ count }: { count: number }) => `${count} 失敗`,
        phaseBlocked: ({ count }: { count: number }) => `${count} ブロック`,
        phasePending: ({ count }: { count: number }) => `${count} 保留`,
        phaseSummary: ({ index, total, complete, agents }: { index: number; total: number; complete: number; agents: number }) => `フェーズ ${index} / ${total} · ${complete}/${agents} エージェント`,
        agentFraction: ({ complete, total }: { complete: number; total: number }) => `${complete}/${total} エージェント`,
        agentsCount: ({ count }: { count: number }) => `${count} エージェント`,
        tokens: ({ tokens }: { tokens: string }) => `${tokens} トークン`,
        toolCalls: ({ count }: { count: number }) => `${count} ツール`,
        showMore: ({ count }: { count: number }) => `表示 ${count}`,
        detailShowMore: 'もっと見る',
        detailShowLess: '折りたたむ',
    },
    subAgentRunView: {
      planTitle: "計画",
      delegateTitle: "委任",
      reviewDigestTitle: "レビュー要約",
    },
    changeTitleView: {
      titleLabel: "タイトル",
    },
    enterPlanMode: {
      title: "プランモードに入りました",
      body:
        "エージェントは、実行前に構造化されたプランを提示します。準備ができたらプランモードを終了するか、変更を依頼できます。",
    },
    structuredResult: {
      exit: "終了コード",
      stdout: "標準出力",
      stderr: "標準エラー",
      diff: "差分",
      result: "結果",
      items: "項目",
      more: ({ count }: { count: number }) => `+${count} 件`,
    },
    taskLikeSummary: {
      createTaskWithSubject: ({ subject }: { subject: string }) => `サブエージェントを作成: ${subject}`,
      createTask: "サブエージェントを作成",
      listTasks: "サブエージェントを一覧表示",
      updateTaskWithIdStatus: ({ id, status }: { id: string; status: string }) => `サブエージェント ${id} を更新 → ${status}`,
      updateTaskWithId: ({ id }: { id: string }) => `サブエージェント ${id} を更新`,
      updateTask: "サブエージェントを更新",
    },
    taskOutputView: {
      waitingForTask: "バックグラウンドタスクの完了を待っています。",
    },
    taskStopView: {
      stoppedCommandLabel: "停止したコマンド",
    },
    taskView: {
      moreTools: ({ count }: { count: number }) => `さらに ${count} 個のツール`,
    },
    workspaceIndexingPermission: {
      defaultTitle: "ワークスペースのインデックス作成",
      description:
        "インデックス作成により、エージェントがコードベースをより速く検索し、より正確な回答を提供できます。ワークスペース内のファイルをスキャンする場合があります。",
      optionFallback: "オプション",
      chooseOptionHint: "続行するには、下のオプションを選択してください。",
    },
    acpHistoryImport: {
      title: "セッション履歴をインポートしますか？",
      defaultNote:
        "このセッション履歴は、Happier に既にある内容と異なります。インポートすると重複が作成される可能性があります。",
      counts: {
        local: ({ count }: { count: number }) => `ローカル: ${count}`,
        remote: ({ count }: { count: number }) => `リモート: ${count}`,
      },
      preview: {
        localTail: "ローカル（末尾）",
        remoteTail: "リモート（末尾）",
        unknownRole: "不明",
      },
      actions: {
        import: "インポート",
        skip: "スキップ",
      },
    },
    askUserQuestion: {
      claudeDialogNotice: {
        header: 'Claude のダイアログ',
        question: 'Claude がダイアログを表示しています。ターミナルを開いて内容を確認し、続行方法を選択してください。',
        openTerminal: 'ターミナルを開く',
        description: 'Claude のターミナルでダイアログを確認して回答します。',
      },
      submit: "回答を送信",
      multipleQuestions: ({ count }: { count: number }) => `${count}件の質問`,
      other: "その他",
      otherDescription: "自分の回答を入力",
      otherPlaceholder: "回答を入力...",
    },
    exitPlanMode: {
      approve: "プランを承認",
      reject: "拒否",
      requestChanges: "変更を依頼",
      planMissing:
        "プランの本文が提供されていません。直前のメッセージ内のプランを確認するか、承認リクエストにプラン本文を含めるようエージェントに依頼してください。",
      requestChangesPlaceholder:
        "このプランで変更したい点をClaudeに伝えてください…",
      requestChangesSend: "フィードバックを送信",
      requestChangesEmpty: "変更したい内容を入力してください。",
      requestChangesFailed:
        "変更の依頼に失敗しました。もう一度お試しください。",
      responded: "送信しました",
      approvalMessage: "このプランを承認します。実装を進めてください。",
      rejectionMessage:
        "このプランを承認しません。修正するか、希望する変更点を確認してください。",
    },
    multiEdit: {
      editNumber: ({ index, total }: { index: number; total: number }) =>
        `編集 ${index}/${total}`,
      replaceAll: "すべて置換",
      summaryEdits: ({ count }: { count: number }) => `${count}件の編集`,
    },
    names: {
      task: "タスク",
      subAgent: "サブエージェント",
      terminal: "ターミナル",
      searchFiles: "ファイル検索",
      search: "検索",
      searchContent: "コンテンツ検索",
      listFiles: "ファイル一覧",
      planProposal: "プラン提案",
      readFile: "ファイル読み取り",
      editFile: "ファイル編集",
      writeFile: "ファイル書き込み",
      fetchUrl: "URL取得",
      readNotebook: "ノートブック読み取り",
      editNotebook: "ノートブック編集",
      todoList: "Todoリスト",
      webSearch: "Web検索",
      reasoning: "推論",
      applyChanges: "ファイルを更新",
      viewDiff: "差分",
      turnDiff: "ターン差分",
      question: "質問",
      changeTitle: "タイトルを変更",
    },
    geminiExecute: {
      cwd: ({ cwd }: { cwd: string }) => `📁 ${cwd}`,
    },
    desc: {
      terminalCmd: ({ cmd }: { cmd: string }) => `ターミナル(cmd: ${cmd})`,
      searchPattern: ({ pattern }: { pattern: string }) =>
        `検索(pattern: ${pattern})`,
      searchPath: ({ basename }: { basename: string }) =>
        `検索(path: ${basename})`,
      fetchUrlHost: ({ host }: { host: string }) => `URL取得(url: ${host})`,
      editNotebookMode: ({ path, mode }: { path: string; mode: string }) =>
        `ノートブック編集(file: ${path}, mode: ${mode})`,
      todoListCount: ({ count }: { count: number }) =>
        `Todoリスト(count: ${count})`,
      webSearchQuery: ({ query }: { query: string }) =>
        `Web検索(query: ${query})`,
      grepPattern: ({ pattern }: { pattern: string }) =>
        `grep(pattern: ${pattern})`,
      multiEditEdits: ({ path, count }: { path: string; count: number }) =>
        `${path} (${count}件の編集)`,
      readingFile: ({ file }: { file: string }) => `${file}を読み取り中`,
      writingFile: ({ file }: { file: string }) => `${file}に書き込み中`,
      modifyingFile: ({ file }: { file: string }) => `${file}を変更中`,
      modifyingFiles: ({ count }: { count: number }) =>
        `${count}ファイルを変更中`,
      modifyingMultipleFiles: ({
        file,
        count,
      }: {
        file: string;
        count: number;
      }) => `${file} 他${count}件`,
      showingDiff: "変更を表示中",
      turnDiffRecap: "このターンで発生した変更の要約",
    },
  },

  files: {
    searchPlaceholder: "ファイルを検索...",
    clearSearchA11y: "検索をクリア",
    createFileA11y: "ファイルを作成",
    createFolderA11y: "フォルダーを作成",
    createFilePromptTitle: "ファイルを作成",
    createFilePromptBody: "プロジェクトのルートからの相対パスを入力してください。",
    createFileInvalidPath:
      "無効なファイルパスです。src/new-file.ts のようなワークスペース相対パスを使用してください。",
    createFileFailed: "ファイルの作成に失敗しました。",
	    createFolderPromptTitle: "フォルダーを作成",
	    createFolderPromptBody: "プロジェクトのルートからの相対フォルダーパスを入力してください。",
	    createFolderInvalidPath:
	      "無効なフォルダーパスです。src/new-folder のようなワークスペース相対パスを使用してください。",
	    createFolderFailed: "フォルダーの作成に失敗しました。",
	    repositoryTree: {
	      actions: {
	        copyPath: "パスをコピー",
	        download: "ダウンロード",
	        downloadAsZip: "ZIPでダウンロード",
	      },
	      dropToUpload: "ファイルをドロップしてアップロード",
	      rename: {
	        title: "名前を変更",
	        body: "プロジェクトのルートからの相対パスで新しいパスを入力してください。",
	        invalidPath:
	          "無効なパスです。src/new-file.ts のようなワークスペース相対パスを使用してください。",
	        failed: "名前の変更に失敗しました。",
	        conflicts: {
	          title: "保存先はすでに存在します",
	          body: ({ path }: { path: string }) => `「${path}」はすでに存在します。どうしますか？`,
	        },
	      },
	      deleteFolder: {
	        title: "フォルダーを削除しますか？",
	        body: ({ path }: { path: string }) =>
	          `フォルダー ${path} とその内容をすべて削除しますか？`,
	        confirm: "フォルダーを削除",
	      },
	      deleteFile: {
	        title: "ファイルを削除しますか？",
	        body: ({ path }: { path: string }) => `ファイル ${path} を削除しますか？`,
	      },
	      delete: {
	        failed: "削除に失敗しました。",
	      },
	      download: {
	        notReady: "ダウンロードはまだ利用できません。",
	      },
	    },
	    changeRow: {
	      viewDiffA11y: ({ file }: { file: string }) => `${file} の差分を表示`,
	      status: {
	        untracked: "未追跡ファイル",
        added: "新規ファイル",
        deleted: "削除されたファイル",
        renamed: "名前変更されたファイル",
        copied: "コピーされたファイル",
        conflicted: "競合ファイル",
        modified: "変更されたファイル",
      },
    },
    projectLinkPicker: {
      title: "プロジェクトファイルをリンク",
      searchFailed: "検索に失敗しました。もう一度お試しください。",
    },
    detachedHead: "切り離された HEAD",
    branchSwitchDialog: {
      title: "ブランチを切り替え",
      body: "未コミットの変更があります。どのように扱いますか？",
      leaveTitle: ({ branch }: { branch: string }) => `${branch} に変更を残す`,
      leaveSubtitle: "現在のブランチにスタッシュして切り替えます。",
      bringTitle: ({ branch }: { branch: string }) => `${branch} に変更を持っていく`,
      bringSubtitle: "切り替えを試み、変更を新しいブランチに引き継ぎます。",
    },
    branchMenu: {
      openA11y: "ブランチメニューを開く",
      failedToLoad: "ブランチの読み込みに失敗しました。",
      unavailable: "ブランチ一覧を利用できません",
      empty: "ブランチが見つかりません",
      searchPlaceholder: "ブランチを検索...",
      category: {
        actions: "操作",
        branches: "ブランチ",
        worktrees: "ワークツリー",
        remote: "リモート",
        local: "ローカル",
        options: "オプション",
      },
      publish: {
        title: "ブランチを公開",
        subtitle: "現在のブランチを上流のリモートブランチにプッシュします",
        short: "公開",
        failed: "ブランチの公開に失敗しました。",
      },
      create: {
        title: "ブランチを作成",
        subtitle: ({ name }: { name: string }) => `「${name}」を作成`,
        failed: "ブランチの作成に失敗しました。",
      },
      switch: {
        failed: "ブランチの切り替えに失敗しました。",
      },
      branch: {
        upstream: ({ upstream }: { upstream: string }) => `上流：${upstream}`,
      },
      remotes: {
        show: "リモートブランチを表示",
        hide: "リモートブランチを非表示",
        subtitle: "一覧にリモートブランチを含めます",
      },
      worktrees: {
        createFromCurrentBranchTitle: "現在のブランチから新しいワークツリーを作成",
        createFromCurrentBranchSubtitle: ({ branch }: { branch: string }) =>
          `${branch} から新しいワークツリーを作成して、その場所でセッションを開始します。`,
        createFromCurrentBranchDetachedSubtitle:
          "現在のブランチからワークツリーを作成する前に、別のブランチに切り替えてください。",
        createFromAnotherBranchTitle: "別のブランチから新しいワークツリーを作成",
        createFromAnotherBranchSubtitle:
          "新しいセッションフローを開いて別のブランチを選ぶか、既存のワークツリーを再利用します。",
        removeTitle: "ワークツリーを削除",
        removeSubtitle: ({ target }: { target: string }) =>
          `このリポジトリから ${target} を削除します。`,
        removeConfirmTitle: "ワークツリーを削除しますか？",
        removeConfirmBody: ({ path }: { path: string }) =>
          `${path} にあるワークツリーを削除しますか？この操作は元に戻せません。`,
        removeConfirmButton: "ワークツリーを削除",
        pruneTitle: "古いワークツリーを整理",
        pruneSubtitle: "このリポジトリの古いワークツリーメタデータを整理します。",
        createFailed: "ワークツリーの作成に失敗しました。",
        removeFailed: "ワークツリーの削除に失敗しました。",
        pruneFailed: "ワークツリーの整理に失敗しました。",
      },
      pullRequests: {
        checkoutLocalTitle: "プルリクエストをチェックアウト",
        checkoutLocalSubtitle: "PR またはマージリクエストの URL、番号、または checkout コマンドを貼り付けます。",
        openWorktreeTitle: "プルリクエストを worktree で開く",
        openWorktreeSubtitle: "プルリクエストを別の worktree に準備し、そこでセッションを開始します。",
        promptTitle: "プルリクエスト参照",
        promptBody: "プルリクエストまたはマージリクエストの URL、番号、または checkout コマンドを貼り付けます。",
        promptPlaceholder: "https://github.com/owner/repo/pull/123",
        invalidReferenceBody: "有効なプルリクエストまたはマージリクエストの参照を入力してください。",
        checkoutFailed: "プルリクエストのチェックアウトに失敗しました。",
        worktreeFailed: "プルリクエストの worktree の準備に失敗しました。",
      },
      indexLock: {
        title: "古い Git ロックを削除しますか？",
        body: "Git がインデックスロックを報告しました。他の Git コマンドが実行中でなければ、Happier が古いロックを削除して再試行できます。",
        confirm: "ロックを削除して再試行",
        recoveryFailed: "Git インデックスロックの削除に失敗しました。",
      },
      stashOverwrite: {
        title: "ブランチのスタッシュを上書きしますか？",
        body: ({ branch }: { branch: string }) =>
          `${branch} のスタッシュは既に存在します。上書きしますか？`,
        confirm: "スタッシュを上書き",
      },
    },
    stash: {
      summaryA11y: "スタッシュの詳細を開く",
      summaryTitle: "管理されたスタッシュ",
      detailsTitle: "管理されたスタッシュ",
      empty: "管理されたスタッシュはありません。",
      failedToLoad: "スタッシュの読み込みに失敗しました。",
      failedToLoadDiff: "スタッシュ差分の読み込みに失敗しました。",
      diffTruncated: "差分が途中で切り詰められました（出力上限）。",
      writeDisabled: "ソースコントロールの書き込み操作が無効です。",
      noSelection: "続行するにはスタッシュを選択してください。",
      selectA11y: ({ stash }: { stash: string }) => `スタッシュ ${stash} を選択`,
      restore: "復元",
      discard: "破棄",
      restoreFailed: "スタッシュの復元に失敗しました。",
      discardFailed: "スタッシュの破棄に失敗しました。",
      restoreConfirm: {
        title: "スタッシュした変更を復元しますか？",
        body: "スタッシュした変更を作業ツリーに適用します。競合は手動で解決する必要がある場合があります。",
        confirm: "復元",
      },
      discardConfirm: {
        title: "スタッシュした変更を破棄しますか？",
        body: "このスタッシュは完全に削除されます。",
        confirm: "破棄",
      },
    },
    summary: ({ staged, unstaged }: { staged: number; unstaged: number }) =>
      `ステージ済み ${staged} • 未ステージ ${unstaged}`,
    branchSummary: {
      ahead: "先行",
      behind: "遅れ",
      included: "含めた",
      staged: "ステージ済み",
      pending: "保留中",
      unstaged: "未ステージ",
      upstreamLabel: ({ upstream }: { upstream: string }) => `Upstream ${upstream}`,
      noUpstream: "上流なし",
    },
    stageActions: {
      selectPendingDiffMode:
        "コミット用に行を選択するには、「保留中」の差分モードを選択してください。",
      unableToBuildPatchFromSelection: "選択した行からパッチを作成できませんでした。",
      diffChangedRefreshAndReselect:
        "差分が変更されました。更新して再選択してください。",
    },
    discardChangesFor: ({ path }: { path: string }) => `${path} の変更を破棄`,
    commitSelection: {
      addToCommit: "コミットに追加",
      removeFromCommit: "コミットから削除",
    },
    sourceControlStatus: {
      changedFilesLabel: ({ count }: { count: number }) => `${count} ファイル`,
    },
    repositoryChangedFiles: ({ count }: { count: number }) =>
      `リポジトリの変更ファイル (${count})`,
    sessionAttributedChanges: ({ count }: { count: number }) =>
      `セッションに紐づく変更 (${count})`,
    latestTurnChanges: ({ count }: { count: number }) =>
      `直近のターンの変更（${count}）`,
    agentReportedTurnChanges: ({ count }: { count: number }) =>
      `エージェントが報告したターンの変更（${count}）`,
    checkpointTurnChanges: ({ count }: { count: number }) =>
      `チェックポイントのターン変更（${count}）`,
    selectedForCommitChanges: ({ count }: { count: number }) =>
      `コミット対象として選択（${count}）`,
    latestTurnDescription:
      '直近で完了したターンのプロバイダ由来の変更です。',
    agentReportedTurnDescription:
      '現在のターンでエージェントが明示的に報告した変更です。',
    checkpointUnavailable:
      'このターンのチェックポイント内容は利用できません。',
    checkpointAttributionShared:
      'チェックポイントの帰属は他のワークツリー活動と共有されています。',
    checkpointAttributionUnknown:
      'チェックポイントの帰属を判定できませんでした。',
    otherRepositoryChanges: ({ count }: { count: number }) =>
      `その他のリポジトリ変更 (${count})`,
    attributionReliabilityHigh:
      "ベストエフォートの帰属です。リポジトリビューが最終的な正です。",
    attributionReliabilityLimited:
      "信頼性は限定的です: このリポジトリで複数のセッションがアクティブです。直接の帰属のみ表示します。",
    attributionLegendFull:
      "direct = このセッションの操作由来, inferred = スナップショット推定",
    attributionLegendDirectOnly: "direct = このセッションの操作由来",
    inferredSuppressed: ({ count }: { count: number }) =>
      `${count}件の推定ファイルを「リポジトリのみの変更」に残しました。`,
    noSessionAttributedChanges:
      "現在、セッションに紐づく変更は検出されていません。",
    noLatestTurnChanges:
      "直近のターンの変更は検出されていません。",
    notRepo: "ソース管理リポジトリではありません",
    notUnderSourceControl: "このディレクトリはソース管理下にありません",
    repositoryInit: {
      initialize: "リポジトリを初期化",
      initializing: "初期化中…",
      confirmTitle: "リポジトリを初期化しますか?",
      confirmBody: "このフォルダーに Git リポジトリを作成します。既存のファイルはステージングもコミットもされません。",
      errors: {
        failed: "リポジトリを初期化できませんでした。",
      },
    },
    searching: "ファイルを検索中...",
      noFilesFound: "ファイルが見つかりません",
      noFilesInProject: "プロジェクトにファイルがありません",
      repositoryFolderLoadFailed: "フォルダを読み込めません",
      repositoryCollapseAll: "すべて折りたたむ",
    sourceControlOperationsLog: {
      title: "最近のソース管理操作",
      allSessions: "すべてのセッション",
      thisSession: "このセッション",
      emptyThisSession: "このセッションの最近の操作はありません。",
    },
    operationsHistory: {
      recentCommits: "最近のコミット",
      noCommitsAvailable: "利用可能なコミットがありません。",
      loadMore: "さらに読み込む",
    },
      reviewFilterPlaceholder: "ファイルを絞り込む...",
      reviewNoMatches: "一致するものがありません",
      reviewLargeDiffOneAtATime: "大きな差分を検出しました。スクロールに応じて差分を読み込みます。",
      reviewDiffRequestFailed: "差分を読み込めません",
      reviewUnableToLoadDiff: "差分を読み込めません",
      tryDifferentTerm: "別の検索語を試してください",
      searchResults: ({ count }: { count: number }) => `検索結果 (${count})`,
      projectRoot: "プロジェクトルート",
    stagedChanges: ({ count }: { count: number }) =>
      `ステージ済みの変更 (${count})`,
      unstagedChanges: ({ count }: { count: number }) =>
        `未ステージの変更 (${count})`,
      // File viewer strings
      fileReadFailed: "ファイルを読み込めませんでした",
      fileTooLargeToPreview: "ファイルが大きすぎてプレビューできません",
      fileWriteFailed: "ファイルを書き込めませんでした",
      fileEditor: {
        experimentalHint:
          "編集は実験的です。保存すると変更がセッションの worktree に書き戻されます。",
        frontmatterReadOnly: 'フロントマター (読み取り専用)',
      },
      fileEditingUnsupported:
        "接続されたデーモンはファイル編集をサポートしていません。書き込み操作を有効にするには、マシン上のHappierを更新してください。",
      fileChangedExternally:
        "編集中にこのファイルがディスク上で変更されました。下書きは変更していません。保存する前に最新のファイルを確認してください。",
      selectionFailed: "選択を更新できませんでした",
      openReviewCommentsFailed: "レビューコメントを開けませんでした",
        reviewComments: {
          title: ({ count }: { count: number }) => `レビューコメント (${count})`,
          placeholder: "レビューコメントを追加…",
          jump: "ジャンプ",
          addCommentA11y: "コメントを追加",
          closeCommentA11y: "コメントを閉じる",
          draftsChipLabel: ({ count }: { count: number }) => `レビュー (${count})`,
          modalSubtitle: "次のメッセージで送信するコメントを確認します。",
          modalSummary: ({ included, count }: { included: number; count: number }) =>
            `${count} 件中 ${included} 件を次のプロンプトに選択中`,
          detachOrDiscardTitle: "レビューコメントを外しますか？",
          detachOrDiscardBody:
            "切り離すとコメントは保存したまま次のプロンプトから除外されます。破棄すると削除されます。",
          detachFromPrompt: "プロンプトから切り離す",
          durable: {
            headerTitle: "レビューコメント",
            count: ({ count }: { count: number }) => `${count}`,
            empty: "レビューコメントはまだありません",
            engine: "エンジン",
            stale: "古い",
            outdated: "更新が必要",
            binarySnapshot: "バイナリスナップショット",
            minified: "圧縮済みの可能性",
            submoduleSnapshot: "サブモジュールスナップショット",
            symlinkSnapshot: "シンボリックリンクスナップショット",
            textSnapshot: "テキストスナップショット",
            tooLargeSnapshot: "スナップショットが大きすぎます",
            encryptedSnapshot: "暗号化されたスナップショット",
            truncated: "切り詰め済み",
            bidiControls: "Bidi 制御文字",
            redacted: "墨消し済み",
            contentUnavailable: "内容は利用できません",
            edit: "編集",
            resolve: "解決",
            dismiss: "却下",
            reopen: "再開",
            redact: "墨消し",
            reply: "返信",
            replyUnavailable: "返信できません",
            bulkResolve: "表示中を解決",
            bulkDismiss: "表示中を却下",
            bulkPartialFailure: "一部のコメントを更新できませんでした",
            bulkFailure: ({ commentId, errorCode }: { commentId: string; errorCode: string }) => `${commentId}: ${errorCode}`,
            filtersTitle: "フィルター",
            showActive: "アクティブ",
            showHistory: "履歴",
            refresh: "更新",
            loadFailed: "レビューコメントを読み込めませんでした",
            transitionReason: "レビューコメントパネルから更新しました。",
            bulkTransitionReason: "レビューコメントパネルから一括更新しました。",
            editPromptTitle: "レビューコメントを編集",
            editPromptBody: "保存済みコメントの本文を更新します。",
            replyPromptTitle: "レビューコメントに返信",
            replyPromptBody: "永続コメントスレッドに返信を追加します。",
            states: {
              proposed: "提案済み",
              open: "未解決",
              delegated: "委任済み",
              pendingReview: "レビュー待ち",
              resolved: "解決済み",
              dismissed: "却下済み",
            },
            directWriteGrant: {
              title: "レビューコメントの直接書き込み",
              body: ({ pluginId }: { pluginId: string }) => `${pluginId} がレビューコメントを直接書き込む権限をリクエストしています。`,
              grant: "直接書き込みを許可",
              cancel: "今はしない",
              revoke: "取り消す",
            },
          },
          errors: {
            empty: "コメントを空にできません",
            couldNotMapSelection: "選択範囲を差分行に対応付けできませんでした",
          },
        },
        commitDetails: {
          missingContext: "コミットのコンテキストがありません",
          failedToLoadDiff: "コミット差分の読み込みに失敗しました",
          diffUnavailableTitle: "コミット差分を表示できません",
          diffUnavailableHint:
            "［ファイル］画面からコミットをもう一度開いてみてください。",
          commitLabel: "コミット",
          running: ({ operation }: { operation: string }) => `実行中: ${operation}`,
          revert: {
            title: "コミットをリバート",
            button: "コミットをリバート",
            confirm: "リバート",
            success: "コミットをリバートしました",
            failed: "コミットのリバートに失敗しました",
          },
        },
        commitRevertUnavailable: "このコミットではリバートできません。",
	        commitMessageEditor: {
	          placeholder: "コミットメッセージ",
	          generate: "生成",
	          generating: "生成中…",
	          applySuggestion: "提案を適用",
	          suggestionReady: "提案が準備できました。適用しますか？",
	          commit: "コミット",
	          generateFailed: "コミットメッセージを生成できませんでした",
	          generatorDisabled: "コミットメッセージ生成が無効です",
	        },
      commitAdjacentPush: {
        accessibilityLabel: ({ target }: { target: string }) => `${target} に push`,
        confirm: {
          title: "ローカルコミットを push しますか？",
          body: ({ target }: { target: string }) =>
            `ローカルコミットを ${target} に push します。`,
          push: "はい",
          notNow: "いいえ",
          pushAndDontAskAgain: "Push して今後確認しない",
        },
      },
      loadingFile: ({ fileName }: { fileName: string }) =>
        `${fileName}を読み込み中...`,
        binaryFile: "バイナリファイル",
        imagePreviewTooLarge: "画像プレビューが大きすぎて表示できません",
        sessionMedia: {
          generatedImageA11y: ({ name }: { name: string }) => `生成画像 ${name} を開く`,
          attachmentImageA11y: ({ name }: { name: string }) => `添付画像 ${name} を開く`,
          toolArtifactImageA11y: ({ name }: { name: string }) => `ツール成果物画像 ${name} を開く`,
          generatedVideoA11y: ({ name }: { name: string }) => `生成動画 ${name} を開く`,
          attachmentVideoA11y: ({ name }: { name: string }) => `添付動画 ${name} を開く`,
          toolArtifactVideoA11y: ({ name }: { name: string }) => `ツール成果物動画 ${name} を開く`,
          previewImageA11y: ({ name, current, total }: { name: string; current: number; total: number }) => `${total} 枚中 ${current} 枚目: ${name}`,

          previewUnavailableA11y: "Media preview unavailable",
          unavailableImageA11y: ({ name }: { name: string }) => `${name} unavailable`,},
        cannotDisplayBinary: "バイナリファイルの内容を表示できません",
        diff: "差分",
      file: "ファイル",
      markdown: "Markdown",
    diffModes: {
      pending: "保留中",
      included: "含めた",
      combined: "統合",
    },
    fileActions: {
      selectForCommit: "コミット対象に選択",
      selectFilesToCommit: "コミットするファイルを選択",
      stageFile: "ファイルをステージ",
      removeFromSelection: "選択から削除",
      removeFromCommitSelection: "コミット選択から削除",
      unstageFile: "ステージ解除",
      selectionHint:
        "行選択を有効にするには「含めた」または「保留中」を選択してください。",
      selectedLines: {
        selectLinesForCommit: "コミット対象の行を選択",
        stageSelectedLines: "選択した行をステージ",
        unstageSelectedLines: "選択した行のステージ解除",
      },
      clearSelection: "選択をクリア",

      rangeSelection: "Range selection",
      selectEntireFileForCommit: "Select entire file for commit",},
	    toolbar: {
	      changedFiles: "変更されたファイル",
	      hiddenFiles: "隠しファイルを表示",
	      details: "詳細",
	      upload: "アップロード",
	      uploadFiles: "ファイルをアップロード",
	      uploadFolder: "フォルダーをアップロード",
      allRepositoryFiles: "リポジトリ内のすべてのファイル",
      repositoryView: "リポジトリ表示",
      selectedForCommitView: "コミット対象として選択",
      turnView: "ターン表示",
      sessionView: "セッション表示",
      view: "表示",
      review: "レビュー",
      list: "一覧",
      scm: "Git",

	      agentReportedTurnView: "エージェント報告ターン",
	      checkpointTurnView: "チェックポイントターン",},
    transfers: {
      preparingUpload: ({ count }: { count: number }) =>
        `アップロード準備中（${count} 件）…`,
      uploading: ({
        completed,
        total,
        uploaded,
        totalBytes,
      }: {
        completed: number;
        total: number;
        uploaded: string;
        totalBytes: string;
      }) => `アップロード中 ${completed}/${total} · ${uploaded} / ${totalBytes}`,
      downloading: ({
        name,
        downloaded,
        totalBytes,
      }: {
        name: string;
        downloaded: string;
        totalBytes: string;
      }) => `ダウンロード中 ${name} · ${downloaded} / ${totalBytes}`,
    },
    upload: {
      conflicts: {
        title: "アップロードの競合",
        body: ({
          conflictCount,
          totalCount,
        }: {
          conflictCount: number;
          totalCount: number;
        }) =>
          `${conflictCount}/${totalCount} 件のファイルが既に存在します。どうしますか？`,
        keepBoth: {
          title: "両方保持",
          subtitle:
            "競合する名前に「 (1)」「 (2)」… を追加します。",
        },
        replace: {
          title: "置き換える",
          subtitle: "既存のファイルを上書きします。",
        },
        skip: {
          title: "スキップ",
          subtitle: "存在しないファイルのみアップロードします。",
        },
      },
    },
    fileEmpty: "ファイルは空です",
    noChanges: "表示する変更はありません",
    sourceControlOperations: {
      title: "バージョン管理",
      actorThisSession: "このセッション",
      actorSession: ({ sessionIdPrefix }: { sessionIdPrefix: string }) =>
        `セッション ${sessionIdPrefix}`,
      running: ({ operation, actor }: { operation: string; actor: string }) =>
        `実行中: ${operation} · ${actor}`,
      lockedBy: ({ actor }: { actor: string }) =>
        `バージョン管理の操作は ${actor} によりロックされています。`,
      globalLock:
        "別のセッションがバージョン管理コマンドを実行中のため、操作は一時的にロックされています。",
      selection: ({ count }: { count: number }) =>
        count === 1
          ? "次のコミットに向けて 1 件のファイルが選択されています。"
          : `次のコミットに向けて ${count} 件のファイルが選択されています。`,
      clear: "クリア",
      conflictsDetected:
        "競合が検出されました。競合が解決されるまで、コミット、プル、プッシュはブロックされます。",
      actions: {
        fetch: "フェッチ",
        pull: "プル",
        push: "プッシュ",
      },
      blockedHints: {
        lock: "ロック",
        commitBlocked: "コミットがブロック",
        pullBlocked: "プルがブロック",
        pushBlocked: "プッシュがブロック",
      },
      update: {
        remotes: {
          title: "リモート",
          empty: "このリポジトリにはリモートが設定されていません。",
          addTitle: "リモートを追加",
          editTitle: ({ name }: { name: string }) => `${name}を編集`,
          add: "リモートを追加",
          remove: "削除",
          nameLabel: "リモート名",
          fetchUrlLabel: "フェッチ URL",
          pushUrlLabel: "プッシュ URL",
          namePlaceholder: "origin",
          fetchUrlPlaceholder: "フェッチ URL",
          pushUrlPlaceholder: "Push URL（任意）",
          noFetchUrl: "Fetch URLなし",
          removeConfirmTitle: "リモートを削除しますか？",
          removeConfirmBody: ({ name }: { name: string }) =>
            `${name}をこのリポジトリから削除しますか？`,
          errors: {
            nameRequired: "リモート名を入力してください。",
            fetchUrlRequired: "Fetch URLを入力してください。",
            addFailed: "リモートを追加できませんでした。",
            saveFailed: "リモートを更新できませんでした。",
            removeFailed: "リモートを削除できませんでした。",
          },
        },
        publishRepository: {
          title: "GitHub に公開",
          body: "GitHub リポジトリを作成し、origin として追加します。",
          ownerLabel: "所有者",
          repositoryNameLabel: "リポジトリ名",
          repositoryNamePlaceholder: "リポジトリ名",
          visibilityLabel: "公開範囲",
          private: "非公開",
          public: "公開",
          internal: "内部",
          remoteKindLabel: "リモート URL",
          httpsRemote: "HTTPS リモート",
          sshRemote: "SSH リモート",
          originConflictLabel: "既存の origin",
          keepOrigin: "置き換えない",
          setOriginUrl: "origin URL を設定",
          pushCurrentBranch: "現在のブランチをプッシュ",
          publish: "リポジトリを公開",
          publishing: "公開中…",
          noTargets: "このリポジトリを公開するには GitHub を接続するか gh CLI でサインインしてください。",
          errors: {
            targetRequired: "GitHub アカウントまたは組織を選択してください。",
            nameRequired: "リポジトリ名を入力してください。",
            loadTargetsFailed: "GitHub の公開先を読み込めませんでした。",
            publishFailed: "リポジトリを公開できませんでした。",
          },

          commitRequired: 'ブランチのプッシュを有効にして公開する前に、コミットを作成してください。',
          unsafeUrl: 'プロバイダーが許可された URL 外のブラウザー操作を返しました。',
          originConflictRemediation: '既存の remote origin を保持するか、新しいホスト済みリポジトリに更新するかを選択してください。',
          auth: {
              connectedAccountReady: 'GitHub 接続サービスを利用できます。',
              providerCliReady: '認証済みの GitHub CLI を利用できます。',
          },
          remediation: {
              connectGitHub: 'GitHub に接続',
              installGh: 'GitHub CLI をインストール',
              useManagedGh: '管理された GitHub CLI を使用',
              authenticateGh: 'GitHub CLI を認証',
              openBrowser: 'ブラウザーを開く',
          },},
        branchIntegration: {
          title: "マージとリベース",
          sourceLabel: "ソースブランチ",
          sourcePlaceholder: "ブランチまたはリモート参照",
          merge: "マージ",
          rebase: "リベース",
          continue: "続行",
          abort: "中止",
          operationInProgress: ({ operation, source }: { operation: string; source: string }) =>
            `${source}からの${operation}が進行中`,
          errors: {
            sourceRequired: "ソースブランチまたは参照を入力してください。",
            mergeFailed: "ブランチをマージできませんでした。",
            rebaseFailed: "ブランチをリベースできませんでした。",
            continueFailed: "操作を続行できませんでした。",
            abortFailed: "操作を中止できませんでした。",
          },
        },
        pullRequests: {
          title: "プルリクエスト",
          readyTitle: "プルリクエストを開けます",
          view: "PRを表示",
          openOrReuse: "PRを開く/再利用",
          pushAndOpen: "プッシュしてPRを開く",
          createFeatureBranch: "機能ブランチを作成",
          createFeatureBranchAndOpen: "ブランチを作成してPRを開く",
          featureBranchPromptTitle: "機能ブランチ名",
          featureBranchPromptBody: "Happier は続行する前にこのブランチをチェックアウトします。",
          defaultBranchRequiresFeature: "デフォルトブランチからプルリクエストを開く前に、機能ブランチを作成してください。",
          defaultBranchDenied: "デフォルトブランチから直接プルリクエストを開くことはできません。",
          states: {
            ready: "準備完了",
            open: "オープン",
            closed: "クローズ",
            merged: "マージ済み",
          },
          status: {
            creating: "プルリクエストを開いています…",
            creatingFeatureBranch: "機能ブランチを作成しています…",
            creatingFeatureBranchPullRequest: "機能ブランチを作成してプルリクエストを開いています…",
            pushingAndCreating: "ブランチをプッシュしてプルリクエストを開いています…",
          },
          unavailable: {
            notRepositoryTitle: "リポジトリが検出されていません",
            notRepositoryBody: "このセッションがソース管理リポジトリに接続されると、プルリクエスト操作が表示されます。",
            unknownProviderTitle: "ホスティングプロバイダーが検出されていません",
            unknownProviderBody: "GitHub、GitLab、またはBitbucketのリモートを追加すると、プルリクエスト操作を有効にできます。",
            noBranchTitle: "ブランチが選択されていません",
            noBranchBody: "プルリクエストを開く前にブランチをチェックアウトしてください。",
            detachedHeadTitle: "切り離された HEAD",
            detachedHeadBody: "プルリクエストを開く前にブランチをチェックアウトしてください。",
          },
          errors: {
            featureBranchRequired: "プルリクエストを開く前に機能ブランチを作成してください。",
            openFailed: "プルリクエストを開けませんでした。",
            branchNameRequired: "機能ブランチ名を入力してください。",
            createBranchFailed: "機能ブランチを作成できませんでした。",
            stackedFailed: "プルリクエストのワークフローを完了できませんでした。",
          },
        },

        pullRequest: {
            title: "プルリクエスト",
            existing: "既存のプルリクエスト",
            ready: "プルリクエストを作成できます",
            branchPair: ({ head, base }: { head: string; base: string }) =>
                `${head} から ${base}`,
            open: "プルリクエストを開く",
            create: "プルリクエストを作成",
            openCompose: "作成画面を開く",
            unsafeUrl: "プロバイダーから、許可されたリポジトリ URL の外部リンクが返されました。",
            defaultBranch: {
                confirmTitle: "機能ブランチを作成しますか?",
                confirmBody: "このデフォルトブランチ上の変更でプルリクエストを開く前に、機能ブランチを作成します。",
                confirm: "ブランチを作成",
            },
        },
        publish: {
            title: "リポジトリを公開",
            description: "ホスティング先のリポジトリを作成し、リモートとして接続します。",
            repositoryNameLabel: "リポジトリ名",
            ownerLabel: "所有者",
            visibilityLabel: "可視性",
            protocolLabel: "リモート URL",
            pushCurrentBranch: "現在のブランチをプッシュ",
            commitRequired: "ブランチのプッシュを有効にして公開する前に、コミットを作成してください。",
            submit: "リポジトリを公開",
            unavailable: "このリポジトリでは公開を利用できません。",
            unsafeUrl: "プロバイダーから、許可された URL の外部ブラウザー操作が返されました。",
            auth: {
                connectedAccountReady: "GitHub 接続サービスを利用できます。",
                providerCliReady: "認証済みの GitHub CLI を利用できます。",
            },
            remediation: {
                connectGitHub: "GitHub に接続",
                installGh: "GitHub CLI をインストール",
                useManagedGh: "管理対象 GitHub CLI を使用",
                authenticateGh: "GitHub CLI を認証",
                openBrowser: "ブラウザーを開く",
            },
            visibility: {
                private: "非公開",
                public: "公開",
                internal: "内部",
            },
            protocol: {
                https: "HTTPS",
                ssh: "SSH",
            },
            remoteConflict: {
                label: "既存の origin リモート",
                fail: "既存の origin を保持",
                setUrl: "origin URL を置き換え",
                remediation: "既存の origin リモートを保持するか、新しいホスト先リポジトリへ更新するかを選択します。",
            },
        },},

      repositoryInit: {
          action: "リポジトリを初期化",
          confirmTitle: "リポジトリを初期化しますか?",
          confirmBody: "このフォルダーの変更を追跡できるように、ソース管理メタデータを作成します。",
          confirm: "初期化",
          failed: "リポジトリを初期化できませんでした。",
      },},

    indexLockRecovery: {
      title: "古い Git index lock を削除しますか？",
      body: "Happier は、このリポジトリで Git が解決した index.lock ファイルを削除し、失敗したソース管理操作を 1 回だけ再試行できます。reset、clean、restore、または広範な修復は実行しません。",
      confirm: "lock を削除して再試行",
      failed: ({ error }: { error: string }) => `index lock の復旧に失敗しました: ${error}`,
    },
    checkpointAttributionExclusive:
      'チェックポイントの内容はこのターン区間に対して正確で、この worktree はこのセッション専用でした。',
    noAgentReportedTurnChanges:
      "このターンについてエージェント報告の変更は検出されていません。",
    noCheckpointTurnChanges:
      "このターンについてチェックポイントの変更は検出されていません。",},

  localServices: {
    inventory: {
      title: 'ローカルサービス',
      loadingTitle: 'ローカルサービスをスキャン中',
      emptyTitle: 'ローカルサービスが検出されません',
      errorTitle: 'ローカルサービスのスキャンに注意が必要です',
      refreshing: '更新中',
      state: {
        listening: '待ち受け中',
        stale: '古い状態',
        gone: '利用不可',
        unknown: '不明',
      },
      address: ({ value }: { value: string }) => `Address: ${value}`,
      folder: ({ value }: { value: string }) => `Folder: ${value}`,
      label: ({ value }: { value: string }) => `Label: ${value}`,
      process: ({ value }: { value: string }) => `Process: ${value}`,
      workspace: ({ value }: { value: string }) => `Workspace: ${value}`,
      confidence: ({ value }: { value: string }) => `Confidence: ${value}`,
            confidenceLabel: {
                strong: '高信頼度の一致',
                moderate: '一致の可能性あり',
                tentative: '暫定一致',
            },
      diagnostic: ({ value }: { value: string }) => `Diagnostic: ${value}`,
      countBadge: ({ total, running }: { total: string; running: string }) => `${total} services · ${running} running`,
    },
    session: {
      thisSessionTitle: 'このセッション',
      workspaceTitle: 'ワークスペース',
    },
    scope: {
      workspace: 'このワークスペース',
      machine: 'このマシン',
      toggleA11y: 'サービスの範囲をこのワークスペースとこのマシンの間で切り替える',
    },
    source: {
      detected: '検出済み',
      managed: '管理対象',
      packageScript: 'パッケージスクリプト',
      preview: 'プレビュー',
      terminalUrl: 'ターミナルURL',
      fileAsset: 'ファイルアセット',
      recent: '最近',
    },
    band: {
      machine: 'その他のマシンサービス',
      suggestions: '候補',
    },
    rowStatus: {
      running: '実行中',
      starting: '起動中',
      stale: '古い',
      stopped: '停止',
      unavailable: '利用不可',
    },
    managed: {
      title: '管理対象サービス',
      emptyTitle: '管理対象サービスなし',
      owner: ({ value }: { value: string }) => `Owner: ${value}`,
      route: ({ value }: { value: string }) => `Route: ${value}`,
      launchMode: ({ value }: { value: string }) => `Mode: ${value}`,
            launchModeLabel: {
                detectedAfterStart: '起動後に検出',
                assignedAtStart: '起動時にポートを割り当て',
                registeredByTool: 'ツールにより登録',
            },
      url: ({ value }: { value: string }) => `URL: ${value}`,
      inventory: ({ value }: { value: string }) => `Inventory: ${value}`,
      diagnostic: ({ value }: { value: string }) => `Diagnostic: ${value}`,
      stopActionA11y: '管理サービスを停止',
      restartActionA11y: '管理サービスを再起動',
      status: {
        starting: '起動中',
        detecting: '検出中',
        running: '実行中',
        unhealthy: '異常',
        stopping: '停止中',
        stopped: '停止済み',
        failed: '失敗',
      },
    },
    launcher: {
      title: 'ランチパッド',
      refreshing: 'ローカルサービスを更新中',
      openInBrowserA11y: 'ローカルサービスをブラウザで開く',
      status: {
        ready: 'プレビューの準備完了',
        managed: '管理対象サービス',
        unavailableGeneric: "このサービスは現在利用できません。",
      },
      unavailableReason: {
        launchUnavailable: "このサービスはここから開始できません。",
        previewRegistrationUnavailable: "このサービスはプレビューを登録できません。",
        browserTargetUnavailable: "このサービスはブラウザーで開けません。",
        starting: "このサービスはまだ起動中です。",
        stale: "このサービスは検出されましたが応答しなくなりました。",
        unavailable: "このサービスは現在利用できません。",
      },
    },
    publicPreview: {
      title: '公開プレビュー',
      createSubtitle: '共有できるプレビューリンクを作成',
      activeSubtitle: '共有リンクが有効です',
      secretLinkMode: 'シークレットリンク',
      disabledPolicySubtitle: 'このサービスでは公開プレビューが無効です。',
      disabledUnsupportedModeSubtitle: '現在 Happier で作成できる公開プレビューはシークレットリンクのみです。',
      disabledLimitSubtitle: '公開プレビューの上限に達しました。別のリンクを作成する前に既存のリンクを取り消してください。',
      disabledNoPreviewSubtitle: '公開リンクを作成する前にローカルプレビューを開いてください。',
      disabledReason: {
        auditUnavailable: '公開プレビューの監査ログを利用できません。',
        dnsTlsUnavailable: '公開プレビューは DNS/TLS の準備完了を待っています。',
        expired: 'この公開プレビューリンクは期限切れです。',
        policyInvalid: '公開プレビューポリシーが不完全です。',
        previewNotEligible: 'このローカルプレビューは公開リンクの対象外です。',
        publicBaseUrlUnavailable: '公開プレビューのベース URL が設定されていません。',
        rateLimitUnavailable: '公開プレビューのレート制限を利用できません。',
        rateLimited: 'この公開プレビューリンクはレート制限されています。',
        relayUnavailable: '公開プレビューのリレーを利用できません。',
        revoked: 'この公開プレビューリンクは取り消されました。',
        secretLinkUnavailable: 'シークレットリンク公開プレビューが設定されていません。',
        sessionNotAuthorized: 'このセッションの公開リンクを作成する権限がありません。',
      },
      createActionA11y: '公開プレビューリンクを作成',
      revokeActionA11y: '公開プレビューリンクを取り消す',
      confirmTitle: 'サービスを公開しますか？',
      confirmMessage: ({ service }: { service: string }) =>
        `「${service}」は共有可能なシークレットリンクを通じてインターネット上で公開されます。`,
      confirmCta: '公開リンクを作成',
            revokeConfirmTitle: '公開リンクを取り消しますか？',
            revokeConfirmMessage: ({ url }: { url: string }) => `公開プレビューリンク ${url} を取り消しますか？利用中のユーザーはアクセスできなくなります。`,
            revokeConfirmCta: 'リンクを取り消す',
    },
    actions: {
      terminateDetectedA11y: '検出されたローカルサービスを終了',
      terminatePidOnlyConfidence: '終了の信頼度: PID のみの識別です。確認が必要です',
            copyAddressA11y: 'サービスアドレスをコピー',
            terminateConfirmTitle: 'サービスを終了しますか？',
            terminateConfirmMessage: ({ service }: { service: string }) => `${service} を終了しますか？正しいプロセスだと確信できる場合にのみ使用してください。`,
            terminateConfirmCta: '終了',
            stopConfirmTitle: 'サービスを停止しますか？',
            stopConfirmMessage: ({ service }: { service: string }) => `${service} を停止しますか？再起動するまでサービスに接続できなくなります。`,
            stopConfirmCta: '停止',
    },
  },

  browserContext: {
    composer: {
      attachPageReference: 'ページを添付',
      startAnnotation: 'ページに注釈',
      cancelAnnotation: '注釈をキャンセル',
      attachAnnotation: '注釈を添付',
      contextUnavailable: 'ブラウザーコンテキストは利用できません',
      attachedPage: ({ title }: { title: string }) => `ページ: ${title}`,
      attachedPageStale: ({ title }: { title: string }) => `ページコンテキストを更新: ${title}`,
      attachedCount: ({ count }: { count: string }) => `${count} 件のブラウザーコンテキスト`,
      removeAttachedContext: 'ブラウザーコンテキストを削除',
      untitledPage: '無題のページ',
    },
  },

  browserRecording: {
    actions: {
      start: '録画を開始',
      stop: '録画を停止',
      cancel: '録画をキャンセル',
    },
    fidelity: {
        pixel: 'ビジュアルキャプチャ',
        cdp: 'ブラウザキャプチャ',
        injectedPage: 'ページキャプチャ',
        nativeCallback: 'ネイティブキャプチャ',
        streamFrame: 'ストリームキャプチャ',
        previewProxy: 'プレビューキャプチャ',
        unavailable: 'キャプチャ待機中',
    },
    status: {
      noView: 'ブラウザービューが選択されていません。',
      unavailable: ({ reason }: { reason: string }) => `録画を利用できません: ${reason}`,
      ready: ({ fidelity }: { fidelity: string }) => `録画準備完了 (${fidelity})`,
      recording: ({ elapsed, fidelity }: { elapsed: string; fidelity: string }) => `録画中 ${elapsed} (${fidelity})`,
      temporary: '一時保存',
      attached: '添付済み',
      discarded: '破棄済み',
    },
  },

  browserAutomation: {
    actions: {
      cancel: '自動操作をキャンセル',
    },
    status: {
      noView: 'ブラウザービューが選択されていません。',
      unavailable: '自動操作を利用できません',
            running: '自動操作中',
            readyForActions: '自動操作の準備完了',
      ready: ({ authority }: { authority: string }) => `自動操作準備完了 (${authority})`,
      active: ({ requestId }: { requestId: string }) => `自動操作中: ${requestId}`,
    },
    timeline: {
      entry: ({ action, status }: { action: string; status: string }) => `${action}: ${status}`,
            action: {
                inspect: 'ページを検査',
                interact: 'ページを操作',
                navigate: 'ページを移動',
                browserAction: 'ブラウザ操作',
            },
            status: {
                succeeded: '完了',
                failed: '失敗',
                canceled: 'キャンセル済み',
                timedOut: 'タイムアウト',
                stale: '古いページ',
                blocked: 'ブロック済み',
                unsupported: '未対応',
            },
    },
  },

  browserSurface: {
    title: 'ブラウザー',
    openA11y: 'ブラウザーを開く',
    openHint: '詳細でブラウザーのランチパッドを開きます。',
    openDisabledA11y: 'ブラウザーは利用できません',
  },

  browserLaunchpad: {
    refreshing: 'ブラウザーターゲットを更新中',
    sections: {
      running: '実行中のプレビュー',
      managed: '管理対象サービス',
      plugin: 'プラグインUI',
      recent: '最近',
      unavailable: '利用不可',
    },
    status: {
      ready: '開けます',
      managed: '管理対象サービス',
      plugin: 'プラグインUI',
      recent: '最近のターゲット',
      openUnavailable: '開く操作は利用できません',
      unavailableGeneric: "このターゲットは現在利用できません。",
    },
    guidance: {
      title: 'まだ実行中のものはありません',
      body: '開発サーバーを起動すると、このワークスペースの localhost ポートがここに自動的に表示されます。上にアドレスを入力することもできます。',
    },
    urlEntry: {
      label: 'アドレスを開く',
      placeholder: 'URLを入力',
      open: 'アドレスを開く',
      invalid: '有効な http または https のアドレスを入力してください。',
    },
    error: {
      title: 'ブラウザーターゲットに注意が必要です',
      subtitle: ({ reason }: { reason: string }) => `更新に失敗しました: ${reason}`,
    },
  },

  browserShell: {
    address: {
      label: 'ブラウザーアドレス',
      placeholder: 'URLを入力',
            copy: 'URL をコピー',
    },
        frame: {
            errorTitle: 'ページを読み込めませんでした',
        },
    nonFramable: {
      title: 'このサイトは埋め込みを拒否しています。',
      openInSystemBrowser: 'システムブラウザーで開く',
    },
    toolbar: {
      back: '戻る',
      forward: '進む',
      reload: '再読み込み',
      stop: '停止',
      openNativeDevtools: 'ネイティブ開発者ツールを開く',
      reloadAfterCrash: 'ページを再読み込み',
    },
    tabs: {
      newTab: '新しいタブ',
    },
    origin: {
      newTab: '新しいタブ',
      localPreview: 'ローカルプレビュー',
      hostedPlugin: 'プラグインUI',
      external: '外部URL',
      streamed: 'ストリーミングブラウザー',
      simulator: 'シミュレーター',
    },
    security: {
      secure: '安全な接続',
      local: 'ローカル接続',
      insecure: '安全でない接続',
      internal: 'アプリ内サーフェス',
      unknown: '接続状態は不明です',
    },
    title: {
      untitled: '無題のページ',
    },
    overflow: {
      open: 'その他のブラウザーツール',
      title: 'ブラウザーツール',
    },
    profile: {
      title: 'ブラウザープロファイルの状態',
      modeLabel: 'モード',
      storageLabel: 'ストレージ',
      permissionsLabel: '権限',
      unavailable: '利用不可',
      mode: {
        ephemeral: '一時',
        session: 'セッション',
        user: 'ユーザー',
        plugin: 'プラグイン',
      },
      storage: {
        unavailable: 'パーティションなし',
        ephemeral: '一時',
        session: 'セッション',
        persistent: '永続',
        plugin: 'プラグイン',
      },
      permissions: {
        none: '権限なし',
        active: ({ count }: { count: number }) => `${count} 件有効`,
        prompt: '確認',
        denied: '拒否',
      },
      management: {
        createProfile: '新規プロファイル',
        selectProfile: 'プロファイルを選択',
        revokePermission: '取り消す',
        clearStorage: 'ストレージを消去',
      },
    },
    privacy: {
      title: 'プライバシーとセキュリティ',
    },
    status: {
      noView: 'ブラウザービューが選択されていません。',
      empty: 'ページが読み込まれていません。',
      noUrl: 'URLが読み込まれていません。',
      loading: '読み込み中…',
      crashed: 'このページは応答しなくなり、閉じられました。',
    },
    unavailable: {
      generic: "このページは現在利用できません。",
      desktopEngineUnavailable: "このマシンでは組み込みブラウザーエンジンを利用できません。",
      desktopWebView: "このマシンでは組み込みブラウザーエンジンを利用できません。",
      desktopWebViewUnsupportedPlatform: "このプラットフォームでは組み込みブラウジングをまだ利用できません。",
      externalUrlPolicyDenied: "このサイトはセキュリティポリシーによってブロックされています。",
      externalUrlUnavailable: "このサイトは組み込みブラウザーで開けません。",
      simulatorPreviewUnavailable: "シミュレータープレビューは現在利用できません。",
      sidecarRuntimeUnavailable: "ブラウザーランタイムは現在利用できません。",
      streamedBrowserUnavailable: "ストリーミングブラウザーは現在利用できません。",
      hostUnavailable: "ブラウザーホストとの接続が切れました。",
      targetKindUnavailable: "このターゲットは組み込みブラウザーで開けません。",
      browserProfileMissing: "このページに利用できるブラウザープロファイルがありません。",
      hostedPluginBlocked: "このプラグインページはセキュリティポリシーによってブロックされています。",
      invalidUrl: "このアドレスは開けません。",
      ownerDisconnected: "ページの所有者との接続が切れました。",
      surface: {
        disabled: "組み込みブラウジングはオフになっています。",
        viewTargetsDisabled: "ブラウザーターゲットはオフになっています。",
        hostLost: "ブラウザーホストとの接続が切れました。",
        adapterRecovering: "ブラウザーに再接続しています…",
        liveStateLost: "ライブブラウザーセッションが失われました。",
        unsupportedTarget: "このターゲットは組み込みブラウザーで開けません。",
      },
    },
    devtools: {
      title: '診断',
      collapse: '診断を折りたたむ',
      expand: '診断を展開する',
      close: '診断を非表示',
      open: '診断を表示',
      section: {
        console: 'コンソール',
                pageErrors: 'ページエラー',
        network: 'ネットワーク',
        elements: '要素',
        resources: 'リソース',
        storage: 'ストレージ',
        info: '情報',
        performance: 'パフォーマンス',
      },
    },
  },

  streamPlayer: {
    status: {
      opening: 'ストリームを開始中…',
      playing: 'ライブ',
      degraded: '低品質',
      reconnecting: '再接続中…',
      stopped: '停止',
      unavailable: 'ストリームを利用できません',
      errorGeneric: 'ストリームエラー',
      decoderUnavailable: 'このブラウザでは動画のデコードを利用できません。',
      preservingLastFrame: '最後のフレームを表示中',
      permissionExpired: '権限の期限切れ',
      leaseExpired: '操作権の期限切れ',
      lowBandwidth: '低帯域幅',
      degradedCodec: 'コーデック低下',
    },
    actions: {
      requestKeyframe: 'キーフレームを要求',
      lowerQuality: '品質を下げる',
    },
    controls: {
      readOnly: '読み取り専用',
      controlling: '操作中',
      controlsUnavailable: '操作不可',
      controlsAvailable: '操作可能',
    },
    renderer: {
      fallback: 'フォールバックレンダラー',
    },
  },

  simulatorPreview: {
    picker: {
      title: 'デバイス',
      empty: '利用可能なシミュレーターデバイスはありません。',
    },
    status: {
      connecting: 'デバイスに接続しています…',
      restoring: 'プレビューを復元しています…',
    },
    availability: {
      available: '利用可能',
      degraded: '低品質',
      unavailable: '利用不可',
      noDevices: '利用可能なシミュレーターデバイスはありません。',
      captureUnavailable: 'このデバイスではキャプチャを利用できません。',
      resourceUnavailable: 'このシミュレーターリソースは利用できません。',
      captureDegraded: 'キャプチャが低下しています。',
      streamDegraded: 'ストリーム品質が低下しています。',
      lastFrame: '最後に利用できたフレームを表示中です。',
      streamUnavailable: 'ストリームを利用できません。',
      unavailableGeneric: 'デバイスプレビューは現在利用できません。',
    },
    toolbar: {
      heldByOther: '別の閲覧者が保持中',
            heldByOtherWithHolder: ({ holder }: { holder: string }) => `${holder} が保持中`,
      acquireControl: '操作権を取得',
      releaseControl: '操作権を解放',
      renewControl: '操作権を更新',
      snapshot: 'スナップショット',
            refreshFrame: 'フレームを更新',
            quality: '品質',
            reduceBandwidth: '帯域幅を下げる',
      fps: '30 FPS上限',
      scale: '1080 px上限',
      rotateLeft: '左に回転',
      homeButton: 'ホーム',
      backButton: '戻る',
      recentButton: '最近',
      volumeUp: '音量を上げる',
      volumeDown: '音量を下げる',
            moreControls: 'その他のデバイス操作',
    },
    sidebands: {
      title: '診断',
      logs: 'ログ',
      accessibilityTree: 'アクセシビリティ',
      deviceConfig: 'デバイス設定',
      appMetadata: 'アプリメタデータ',
      networkDiagnostics: 'ネットワーク',
      route: 'ルート',
      captureHealth: 'キャプチャ状態',
      refresh: '更新',
      empty: 'まだデータはありません。',
            open: '診断を開く',
            close: '診断を閉じる',
            refreshA11y: ({ section }: { section: string }) => `${section} を更新`,
            arrayValue: ({ count }: { count: string }) => `${count} 件`,
            objectValue: ({ count }: { count: string }) => `${count} 個のフィールド`,
            valueUnavailable: '利用不可',
            fields: {
                level: 'レベル',
                message: 'メッセージ',
                route: 'ルート',
                status: '状態',
                reason: '理由',
            },
    },
    diagnostics: {
      item: ({ reasonCode }: { reasonCode: string }) => `診断: ${reasonCode}`,
    },
  },

  browserDiagnostics: {
    previewProxy: {
      title: 'プレビュー診断',
      status: {
        available: '利用可能',
        stale: '古い',
        unavailable: '利用不可',
      },
      fidelity: {
        previewProxy: 'プレビュープロキシ',
        unavailable: '利用不可',
        cdp: 'CDP',
        injectedPage: '注入ページ',
        nativeCallback: 'ネイティブコールバック',
        streamFrame: 'ストリームフレーム',
      },
      activeFlows: ({ count }: { count: string }) => `${count} 件のアクティブフロー`,
      attributionAllViews: 'このプレビューの全ビューのトラフィック',
      staleNotice: '診断は古くなっています。再接続すると新しいスナップショットを要求します。',
      unavailableReason: ({ reasonCode }: { reasonCode: string }) => `診断を利用できません: ${reasonCode}`,
      networkEmpty: 'プレビュートラフィックはまだキャプチャされていません。',
      familyAvailable: ({ family }: { family: string }) => `${family}: 利用可能`,
      familyUnavailable: ({ family }: { family: string }) => `${family}: 利用不可`,
      httpFlow: ({ method, path, statusCode }: { method: string; path: string; statusCode: string }) => `${method} ${path} - ${statusCode}`,
      webSocketFlow: ({ subprotocol }: { subprotocol: string }) => `WebSocket - ${subprotocol}`,
      tunnelFlow: ({ flowId }: { flowId: string }) => `トンネル ${flowId}`,
      flowBytes: ({ bytesIn, bytesOut }: { bytesIn: string; bytesOut: string }) => `入力 ${bytesIn} B / 出力 ${bytesOut} B`,
      flowMessages: ({ messagesIn, messagesOut }: { messagesIn: string; messagesOut: string }) => `メッセージ ${messagesIn}/${messagesOut}`,
    },
    host: {
      title: 'ブラウザー診断',
      eventCount: ({ count }: { count: string }) => `${count} 件の診断イベント`,
      untrustedNotice: '注入された診断はページ側で改ざん可能で、低い忠実度です。',
      untrustedEvent: '信頼されない注入イベント',
      eventsEmpty: 'ブラウザー診断はまだキャプチャされていません。',
      eventTitle: ({ family, kind }: { family: string; kind: string }) => `${family} - ${kind}`,
            eventTitles: {
                pageError: 'ページエラー',
                console: 'コンソールメッセージ',
            },
            eventKinds: {
                pageError: 'ページエラー',
                consoleEntry: 'コンソール項目',
                network: 'ネットワークイベント',
                event: 'イベント',
            },
      eventSummaryUnavailable: '利用できるメタデータはありません',
      families: {
        console: 'コンソール',
                pageError: 'ページエラー',
        elements: '要素',
        resources: 'リソース',
        storage: 'ストレージ',
        performance: 'パフォーマンス',
        network: 'ネットワーク',
        pageInfo: 'ページ情報',
                other: '診断',
            },
      detail: {
        keys: ({ count }: { count: string }) => `キー (${count})`,
        entries: ({ count }: { count: string }) => `リソース (${count})`,
      },
      fields: {
        method: 'メソッド',
        status: 'ステータス',
        url: 'URL',
        duration: '時間',
        requestSize: 'リクエスト',
        responseSize: 'レスポンス',
        socket: 'ソケット',
        state: '状態',
        framesSent: '送信フレーム',
        framesReceived: '受信フレーム',
        bytesSent: '送信バイト',
        bytesReceived: '受信バイト',
        messages: 'メッセージ',
        protocol: 'プロトコル',
        selector: 'セレクター',
        backendNode: 'バックエンドノード',
        rect: '矩形',
        accessibleName: 'アクセシブル名',
        storageType: 'ストレージ種別',
        keyCount: 'キー',
        truncated: '切り詰め',
        level: 'レベル',
        arguments: '引数',
        message: 'メッセージ',
        serviceWorker: 'サービスワーカー',
        webgl: 'WebGL 状態',
        webrtc: 'WebRTC 状態',
        nodeCount: 'ノード',
        elementCount: '要素',
        maxDepth: '最大深度',
        readyState: '準備状態',
        lcp: 'LCP',
        cls: 'CLS',
        inp: 'INP',
        fcp: 'FCP',
        longTasks: '長時間タスク',
        longTaskTime: '長時間タスク時間',
        responseEnd: 'レスポンス終了',
        domContentLoaded: 'DOM 準備完了',
        loadEventEnd: '読み込み終了',
        type: '種類',
      },
      interaction: {
        title: 'インタラクティブ診断',
        enabled: 'インタラクティブ診断は有効です',
        disabled: 'インタラクティブ診断は無効です',
        unavailable: ({ reasonCode }: { reasonCode: string }) => `インタラクティブ診断は利用できません: ${reasonCode}`,
        ownerOnly: 'セッション所有者だけがインタラクティブ診断を有効にできます。',
        enable: 'インタラクションを有効化',
        disable: 'インタラクションを無効化',
        startPicker: '要素を選択',
        cancelPicker: 'ピッカーをキャンセル',
        pickerActive: '要素ピッカーが有効です',
        pickerUnavailable: '要素ピッカーは利用できません',
        eval: {
            title: 'コンソール',
            placeholder: '式を評価',
            run: '実行',
            empty: '評価済みの式はまだありません。',
            resultLabel: '結果',
            statusPending: '評価中…',
            statusCompleted: '完了',
            statusFailed: '失敗',
            statusTimedOut: 'タイムアウト',
            statusBlocked: 'ブロック済み',
            statusDegraded: 'コレクターが低下しています',
            error: ({ reasonCode }: { reasonCode: string }) => `エラー: ${reasonCode}`,
            expand: '展開',
            collapse: '折りたたむ',
            loading: 'プロパティを読み込み中…',
            noProperties: 'プロパティはありません。',
            propertiesFailed: ({ reasonCode }: { reasonCode: string }) => `プロパティを利用できません: ${reasonCode}`,
        },
      },
    },
  },

  executionRuns: {
    newRun: {
      headerTitle: "実行を開始",
      sections: {
        intent: "目的",
        permissions: "権限",
        backends: "バックエンド",
        profiles: "プロファイル",
        instructions: "指示",
      },
      intents: {
        review: "レビュー",
        plan: "計画",
        delegate: "委任",
      },
      permissionModes: {
        readOnly: "読み取り専用",
        default: "既定",
      },
      instructionsPlaceholder: "サブエージェントに何をさせますか？",
      actions: {
        start: "開始",
      },
      guidancePreview: "ガイダンスプレビュー",
      a11y: {
        startRun: "実行を開始",
        cancel: "キャンセル",
        selectIntent: ({ intent }: { intent: string }) =>
          `目的を選択 ${intent}`,
        selectPermissionMode: ({ mode }: { mode: string }) =>
          `権限を選択 ${mode}`,
        selectProfile: ({ profile }: { profile: string }) => `プロファイルを選択 ${profile}`,
        toggleBackend: ({ backendId }: { backendId: string }) =>
          `バックエンドを切り替え ${backendId}`,
      },
    },
    details: {
      titles: {
        executionRun: "実行",
        executionRunWithIntent: ({ intent }: { intent: string }) => `${intent} · 実行`,
      },
      labels: {
        status: "ステータス",
        statusValue: ({ value }: { value: string }) => `Status: ${value}`,
        runId: ({ value }: { value: string }) => `Run ID: ${value}`,
        backend: ({ value }: { value: string }) => `Backend: ${value}`,
        permissions: ({ value }: { value: string }) => `Permissions: ${value}`,
        mode: ({ value }: { value: string }) => `Mode: ${value}`,
        intent: "意図",
        backendId: "バックエンドID",
        permissionMode: "権限モード",
        retentionPolicy: "保持ポリシー",
        runClass: "実行クラス",
        ioMode: "I/Oモード",
      },
      timestamps: {
        started: "開始",
        finished: "完了",
      },
    },
  },

      settingsActions: {
      aboutSubtitle: "各アクションをアプリ、音声、統合のどこに表示するかを選択します。利用不可のタイルは表示したままにして、機能、プライバシー、ランタイムのどれでブロックされているかを分かるようにします。",
      aboutFooter: "これらの設定はアカウント既定にグローバルに適用されます。利用不可のタイルは、対象が現在ブロックされている理由を示します。",
      searchPlaceholder: "アクションを検索",
      detailSearchPlaceholder: "サーフェスを検索",
      noResults: "現在の検索に一致するアクションはありません。",
      noTargetsMatch: "現在の検索に一致するサーフェスはありません。",
      noDescription: "まだ説明はありません。",
      requireApproval: "承認を必須にする",
      invalidActionTitle: "アクションが見つかりません",
      invalidActionSubtitle: "このアクションはこのビルドでは利用できなくなりました。",
      configureActionAccessibilityLabel: "アクションを設定",
      approvalHelpTitle: "承認モード",
      approvalHelpBody: "「先に確認」では、このサーフェスからアクションを実行する前に確認を表示します。「許可」では、このサーフェスから承認プロンプトなしで実行できます。",
      toolExposure: {
          title: "ツール公開",
          footer: "対象のアクションを直接ツールとして表示するか、アクション検索からのみ利用できるようにするかを制御します。",
          subtitle: "このサーフェスでの直接ツール登録を制御します。",
          disabledSubtitle: "ツール公開を変更する前に、このサーフェスをオンにしてください。",
          options: {
              default: {
                  subtitle: "このサーフェスの製品既定値に従います。",
              },
              defaultDiscoverableOnly: {
                  title: "既定を使用（検索のみ）",
              },
              defaultDirect: {
                  title: "既定を使用（直接ツール）",
              },
              discoverableOnly: {
                  title: "検索のみ",
                  subtitle: "直接ツールを追加せず、アクション検索から利用できます。",
              },
              direct: {
                  title: "直接ツール",
                  subtitle: "このアクションを直接呼び出せるツールとして登録します。",
              },
          },
      },
      spawnPolicy: {
          title: "AI セッション作成ポリシー",
          footer: "これらの設定は、Happier セッション内のアシスタントが別のセッションを作成するときだけ適用されます。親から継承した設定は引き続き許可され、拒否された項目は明確なエラーで明示的な上書きを拒否します。",
          toggles: {
              allowCustomDirectory: { title: "カスタムディレクトリ", subtitle: "別の作業ディレクトリをアシスタントが選べるようにします。" },
              allowCrossMachine: { title: "別マシンの対象", subtitle: "利用可能な別のマシンでセッションを作成できるようにします。" },
              allowBackendTargetOverride: { title: "バックエンド対象", subtitle: "別のエージェントまたはバックエンド対象を選べるようにします。" },
              allowModelOverride: { title: "モデル", subtitle: "親モデルを継承する代わりにモデルを選べるようにします。" },
              allowPermissionModeOverride: { title: "権限モード", subtitle: "同等または低い権限の上書きを許可します。昇格は引き続き拒否されます。" },
              allowAgentModeOverride: { title: "エージェントモード", subtitle: "エージェントまたはセッションモードを選べるようにします。" },
              allowConfigOptionOverrides: { title: "設定オプション", subtitle: "思考 effort や workflow などのプロバイダー設定を許可します。" },
              allowProfileOverride: { title: "プロファイル", subtitle: "秘密情報を公開せずに profile id を選べるようにします。" },
              allowEnvironmentVariables: { title: "環境変数", subtitle: "新しいセッションで明示的な環境変数を許可します。" },
              allowConnectedServicesOverride: { title: "接続済みサービス", subtitle: "接続済みサービスのバインディングを参照で選べるようにします。" },
              allowMcpSelectionOverride: { title: "MCP 選択", subtitle: "継承した MCP サーバー選択を上書きできるようにします。" },
              allowTranscriptStorageOverride: { title: "トランスクリプト保存", subtitle: "互換性のある保存モードを選べるようにします。" },
          },
          permissionCeiling: {
              title: "権限上限",
              subtitle: "呼び出し元の権限より低い追加上限を任意で設定します。",
              options: {
                  inherit: { title: "追加上限なし", subtitle: "呼び出し元の権限だけを上限にします。" },
                  default: { title: "デフォルト", subtitle: "通常の承認動作またはそれ以下に制限します。" },
                  acceptEdits: { title: "編集を許可", subtitle: "自動編集を許可しますが、完全な bypass は許可しません。" },
                  bypassPermissions: { title: "権限をバイパス", subtitle: "呼び出し元にもある場合だけ完全な bypass まで許可します。" },
                  plan: { title: "計画", subtitle: "作成されるセッションを計画または読み取り専用に制限します。" },
                  "read-only": { title: "読み取り専用", subtitle: "作成されるセッションを読み取り専用に制限します。" },
                  "safe-yolo": { title: "セーフ yolo", subtitle: "ワークスペースへの安全な自動書き込みを許可します。" },
                  yolo: { title: "Yolo モード", subtitle: "呼び出し元にもある場合だけ yolo まで許可します。" },
              },
          },
      },
      status: {
          allowed: ({ count }: { count: number }) => `${count} 許可`,
          askFirst: ({ count }: { count: number }) => `${count} 先に確認`,
          off: ({ count }: { count: number }) => `${count} オフ`,
          unavailable: ({ count }: { count: number }) => `${count} 利用不可`,
      },
      modes: {
          off: "オフ",
          askFirst: "先に確認",
          allowed: "許可",
      },
        sections: {
            app: "アプリ内",
            voice: "音声",
            integrations: "統合",
        },
        families: {
            browser: {
                title: "ブラウザ",
            },
            simulator: {
                title: "シミュレーター",
            },
            localServices: {
                title: "ローカルサービス",
            },
            plugins: {
                title: "プラグイン",
            },
            session: {
                title: "セッション",
            },
            scm: {
                title: "バージョン管理",
            },
            general: {
                title: "一般",
            },
        },
        badges: {
            unavailable: "利用不可",
        },
        reasons: {
            voiceFeature: "この対象を使うには、音声アシスタント設定を有効にしてください。",
            voiceInventoryPrivacy: "この対象を使うには、音声アシスタントのプライバシー設定でデバイス情報の共有を有効にしてください。",
            mcpFeature: "このアクションを MCP 経由で表示するには MCP サーバーを有効にしてください。",
            executionRunsFeature: "このアクションまたは対象を使うには execution runs を有効にしてください。",
            memorySearchFeature: "このアクションを使うにはローカルメモリ検索を有効にしてください。",
            sessionHandoffFeature: "このアクションを使うにはセッションハンドオフを有効にしてください。",
            notAvailableInThisApp: 'このターゲットは、このクライアントではまだ表示されません。',
            requiredByAgentPolicy: 'ポリシーによりエージェントの承認が必要です。このアクションは常に最初に確認します。',
        },
        targets: {
            session_header: {
                title: "セッションヘッダー",
                subtitle: "セッションヘッダーツールバーに表示されます。",
            },
            session_action_menu: {
                title: "セッションメニュー",
                subtitle: "セッションの操作メニューに表示されます。",
            },
            session_info: {
                title: "セッション詳細",
                subtitle: "セッション情報画面に表示されます。",
            },
            pending_messages: {
                title: "保留中のメッセージ",
                subtitle: "セッションのトランスクリプト下にある保留中メッセージの操作に表示されます。",
            },
            command_palette: {
                title: "コマンドパレット",
                subtitle: "グローバルコマンドパレットに表示されます。",
            },
            slash_command: {
                title: "スラッシュコマンド",
                subtitle: "スラッシュコマンド形式のアクションピッカーから利用できます。",
            },
            agent_input_chips: {
                title: "コンポーザーのチップ",
                subtitle: "エージェント入力の近くにクイックチップとして表示されます。",
            },
            voice_panel: {
                title: "音声パネル",
                subtitle: "音声アシスタントパネルに表示されます。",
            },
            run_list: {
                title: "実行ラン一覧",
                subtitle: "execution run の一覧から表示されます。",
            },
            run_card: {
                title: "実行ランカード",
                subtitle: "execution run カードに表示されます。",
            },
            voice_tool: {
                title: "音声ツール",
                subtitle: "音声エージェントから呼び出し可能なツールとして利用できます。",
            },
            voice_action_block: {
                title: "音声アクションブロック",
                subtitle: "音声アクションブロックと操作要素の中に表示されます。",
            },
            agent: {
                title: "セッションエージェント",
                subtitle: "セッション内のエージェントが呼び出し可能なツールとして利用できます。",
            },
            mcp: {
                title: 'MCP',
                subtitle: "MCP アクションカタログから利用できます。",
            },
            cli: {
                title: "セッション制御 CLI",
                subtitle: "セッション制御 CLI の画面から利用できます。",
            },
            contextual_ui: {
                title: "コンテキスト UI",
                subtitle: "専用の表示先を持たないコンテキスト UI 上に表示されます。",
            },

            voice: {
                title: "音声",
                subtitle: "音声エージェントから呼び出し可能なサーフェスとして利用できます。",
            },},
    },

settingsSession: {
	    sessionList: {
	        title: 'セッション一覧',
	        footer: '各セッション行に表示する内容をカスタマイズします。',
	        tagsTitle: 'セッションタグ',
	        tagsEnabledSubtitle: 'セッション一覧にタグ操作を表示',
	        tagsDisabledSubtitle: 'タグ操作を非表示',
	        workingStatusAnimatedTextTitle: '作業中テキストのアニメーション',
	        workingStatusAnimatedTextEnabledSubtitle: 'セッションの実行中に作業中の動詞を切り替えます',
	        workingStatusAnimatedTextDisabledSubtitle: 'セッションの実行中は固定の「作業中...」ラベルを表示します',
	        narrowWorkingIndicatorTitle: 'ナロー表示の作業中インジケーター',
	        narrowWorkingIndicatorSpinnerSelectedSubtitle: 'ナロー行に小さなニュートラルスピナーを表示します',
	        narrowWorkingIndicatorPulseSelectedSubtitle: 'ナロー行に点滅するドットを表示します',
	        narrowWorkingIndicatorSpinnerTitle: 'スピナー',
	        narrowWorkingIndicatorSpinnerSubtitle: 'セッションの作業中にコンパクトなニュートラルスピナーを表示します。',
	        narrowWorkingIndicatorPulseTitle: '点滅ドット',
	        narrowWorkingIndicatorPulseSubtitle: 'セッションの作業中にコンパクトなアニメーションドットを表示します。',
	        workingIndicatorTitle: '作業インジケーター',
	        workingIndicatorSpinnerSelectedSubtitle: 'セッションの作業中に小さなニュートラルスピナーを表示します',
	        workingIndicatorPulseSelectedSubtitle: 'セッションの作業中に点滅するドットを表示します',
	        workingIndicatorSpinnerTitle: 'スピナー',
	        workingIndicatorSpinnerSubtitle: 'セッションの作業中にコンパクトなニュートラルスピナーを表示します。',
	        workingIndicatorPulseTitle: '点滅ドット',
	        workingIndicatorPulseSubtitle: 'セッションの作業中にコンパクトなアニメーションドットを表示します。',
	        identityDisplayTitle: 'セッションの識別表示',
	        identityDisplaySubtitle: '一覧でセッション名の前に表示するものを選びます。',
	        identityDisplayAvatarTitle: 'アバター',
	        identityDisplayAvatarSubtitle: '各セッションの生成アバターを表示します。',
	        identityDisplayAgentLogoTitle: 'エージェントロゴ',
	        identityDisplayAgentLogoSubtitle: '各セッションのエージェントロゴを表示します。',
	        identityDisplayNoneTitle: 'なし',
	        identityDisplayNoneSubtitle: 'セッション行の識別マーカーを非表示にします。',
	        headerIdentityDisplayTitle: 'セッションヘッダーの識別表示',
	        headerIdentityDisplaySubtitle: 'セッション内でタイトルの前に表示する内容を選択します。',
	        headerIdentityDisplayAvatarTitle: 'アバター',
	        headerIdentityDisplayAvatarSubtitle: 'セッションの生成されたアバターを表示します。',
	        headerIdentityDisplayAgentLogoTitle: 'エージェントのロゴ',
	        headerIdentityDisplayAgentLogoSubtitle: 'セッションを実行しているエージェントのロゴを表示します。',
	        headerIdentityDisplayNoneTitle: 'なし',
	        headerIdentityDisplayNoneSubtitle: 'ヘッダーをセッションのタイトルから始めます。',
	        activeColorTitle: 'アクティブなタイトル色',
	        activeColorSubtitle: 'アクティブなタイトル色を使うセッションを選びます。',
	        activeColorActivityAndAttentionTitle: '動作中と注意が必要',
	        activeColorActivityAndAttentionSubtitle: '動作中のセッションと注意が必要なセッションにアクティブ色を使います。',
	        activeColorAttentionOnlyTitle: '注意が必要なもののみ',
	        activeColorAttentionOnlySubtitle: '注意が必要なセッションにのみアクティブ色を使います。',
	        activeColorAllActiveTitle: 'すべてのアクティブセッション',
	        activeColorAllActiveSubtitle: 'アクティブで接続中のすべてのセッションにアクティブ色を使います。',
	        sectionModeTitle: 'セッションセクション',
	        sectionModeSubtitle: 'セッションをアクティビティ別に分けるかどうかを選びます。',
	        sectionModeActivitySelectedSubtitle: 'アクティブと非アクティブのセッションを分ける',
	        sectionModeSingleSelectedSubtitle: 'ワークスペース別にまとめた 1 つのセッションセクションを表示',
	        sectionModeActivityTitle: 'アクティブと非アクティブ',
	        sectionModeActivitySubtitle: 'ワークスペースでグループ化する前に、アクティビティ別にセッションを分けます。',
	        sectionModeSingleTitle: 'すべてのセッションをまとめる',
	        sectionModeSingleSubtitle: '1 つのセッションセクションを使い、各セッションをワークスペース別にグループ化します。',
	        menuSections: {
	          sortBy: '並び替え',
	          show: '表示',
	          folderSortMode: 'フォルダー順序',

	          organize: '整理',},
	        orderingTitle: 'セッションの並び順',
	        orderingSubtitle: 'グループ内でセッションを並べる方法を選択します。',
	        orderingOptions: {
	          custom: 'カスタム',
	          created: '作成日時',
	          updated: '更新日時',
	        },
	        folderSortModeTitle: 'フォルダー順序',
	        folderSortModeSubtitle: 'フォルダーとセッションが一覧内でどう並ぶかを選びます。',
	        folderSortModeFoldersFirstTitle: 'フォルダーを先に表示',
	        folderSortModeFoldersFirstSubtitle: '各ワークスペースまたはフォルダーで、フォルダーをセッションの上にまとめます。',
	        folderSortModeMixedTitle: '混在',
	        folderSortModeMixedSubtitle: 'フォルダーとセッションを正確な共有順序で並べられるようにします。',
	        folderSortModeMixedDisabledInDateModeSubtitle: '混在フォルダー順はカスタム順で利用できます。',
	        attentionPromotionModeTitle: '確認が必要なセッション',
	        attentionPromotionModeSubtitle: '対応待ちまたはレビュー準備完了のセッションを表示する場所を選択します',
	        attentionPromotionModeOffTitle: '通常の位置のまま',
	        attentionPromotionModeOffSubtitle: 'グループ化と並び順をそのまま維持します',
	        attentionPromotionModeGlobalTitle: '上部にまとめる',
	        attentionPromotionModeGlobalSubtitle: 'ほかのセッションより上に確認セクションを表示します',
	        attentionPromotionModeWithinGroupsTitle: '現在のグループの上部へ移動',
	        attentionPromotionModeWithinGroupsSubtitle: 'フォルダーまたはワークスペース内に維持します',
	        workingPlacementModeTitle: '処理中のセッション',
	        workingPlacementModeSubtitle: '現在処理中のセッションを表示する場所を選択します',
	        workingPlacementModeOffTitle: '通常の位置のまま',
	        workingPlacementModeOffSubtitle: '処理中のセッションを現在のグループ化と並び順のまま維持します',
	        workingPlacementModeGlobalTitle: '上部にまとめる',
	        workingPlacementModeGlobalSubtitle: '確認が必要なセッションの下に処理中セクションを表示します',
	        workingPlacementModeWithinGroupsTitle: '現在のグループの上部へ移動',
	        workingPlacementModeWithinGroupsSubtitle: '処理中のセッションをフォルダーまたはワークスペース内に維持します',
	        workspacePathDisplayTitle: 'ワークスペース名',
	        workspacePathDisplayNameSelectedSubtitle: '既定で最後のフォルダー名を表示',
	        workspacePathDisplayPathSelectedSubtitle: 'ワークスペースのフルパスを表示',
	        workspacePathDisplayName: 'フォルダー名',
	        workspacePathDisplayNameDescription: 'ワークスペース名を変更していない場合は、パスの最後の部分を使います。',
	        workspacePathDisplayPath: 'フルパス',
	        workspacePathDisplayPathDescription: 'ワークスペース名を変更していない場合は、整形済みのワークスペースパスを使います。',
	        workspaceFaviconsTitle: 'ワークスペースのファビコン',
	        workspaceFaviconsEnabledSubtitle: '検出したプロジェクトのファビコンをワークスペース名の横に表示',
	        workspaceFaviconsDisabledSubtitle: 'ワークスペース見出しでプロジェクトのファビコンを非表示',
	        workspaceMachineSubtitlesTitle: 'マシン名',
	        workspaceMachineSubtitlesEnabledSubtitle: '必要な場合にワークスペース名の下にマシン名を表示',
	        workspaceMachineSubtitlesDisabledSubtitle: 'ワークスペース見出しでマシン名を非表示',

	        folderTreeView: "Folder tree view",},
	    mobileWorkspaceExperience: {
	        groupTitle: 'モバイルワークスペース',
	        groupFooter: 'スマートフォンサイズのセッション画面の構成を設定します。',
	        title: 'コックピットモード',
	        subtitle: 'セッション内で使うスマートフォン向けレイアウトを選択します。',
	        options: {
	            cockpitTitle: 'コックピット',
	            cockpitSubtitle: 'チャット、ファイル、Git、タブ、ターミナルを下部タブで切り替えます。',
	            classicTitle: 'クラシック',
	            classicSubtitle: '従来のセッション画面レイアウトを使います。',
	        },
	    },
	    input: {
	        title: '入力の外観',
	        footer: 'エージェント入力バーの外観を設定します。',
	    },
        detailedBehavior: { title: '詳細なセッション動作', footer: '入力、プロバイダー制限、再開、ターミナルの詳細設定を開きます。' },
        rootGroups: {
            launchDefaults: { title: '新規セッションの既定値', footer: '新しいセッションの開始方法と記憶する選択内容を選びます。' },
            listOrganization: { title: 'セッションリストの整理', footer: '並び順、グループ化、セクション、非アクティブなセッション、デスクトップペインの既定値を制御します。' },
            rowDetails: { title: 'セッション行の詳細', footer: '各セッション行に表示するラベルと視覚的な詳細を選びます。' },
            activitySignals: { title: 'アクティビティとステータスの表示', footer: 'アクティブ、作業中、注意が必要なセッションをどのように目立たせるかを制御します。' },
            mobileLayout: { title: 'モバイルのセッションレイアウト', footer: 'セッション内で使う電話向けレイアウトを選びます。' },
            agentPersonalization: { title: 'エージェントのプロンプト指示', footer: 'エージェントにセッション名や返信候補を提案させる指示を制御します。' },
        },
        composer: { title: '入力と送信', entrySubtitle: 'Enter で送信、履歴、入力欄の外観、実行中の送信動作。' },
        providerLimits: { title: 'プロバイダー制限と使用量', entrySubtitle: '使用制限からの回復とコンポーザー横の使用量ゲージ。' },
        resume: { title: '再開とハンドオフ', entrySubtitle: 'トランスクリプト再生による再開とマシン間移動の既定値。' },
        runtime: { title: 'ランタイムとターミナル', entrySubtitle: 'tmux、Windows Terminal ウィンドウ、Terminal Connect 互換性。' },
    banners: {
        title: 'バナー',
        footer: '入力欄の上のバナーはステータスバッジに折りたためます。その状態を記憶するかどうかを選べます。',
        rememberVisibilityTitle: 'バナーの表示状態を記憶する',
        rememberVisibilitySubtitle: '閉じたバナーは、この端末のすべてのセッションで非表示のままになります。',
        resetHiddenTitle: '非表示のバナーをすべて表示',
        resetHiddenSubtitle: 'この端末で非表示にしたバナーを解除します。',
    },
    inputBehavior: {
        title: '入力の動作',
        footer: 'Enterで送信とメッセージ履歴の動作を設定します。',
        enterToSendEnabledNativeSubtitle: 'Enterで送信',
    },
    windows: {
        title: 'Windows',
        defaultModeTitle: 'Windows リモートセッションの既定モード',
        windowNameTitle: 'Windows Terminal のウィンドウ名',
        windowNamePlaceholder: 'happier',
        windowNameHint: 'Windows Terminal で開くセッションはこの名前付きウィンドウを使い、新しいセッションをタブとして表示できます。',
    },
    advanced: {
        title: '詳細',
    },
    messageSending: {
      title: "メッセージ送信",
      footer:
        "エージェント実行中にメッセージを送信したときの挙動を設定します。",
        queueInAgentTitle: "エージェントにキュー（現在）",
        queueInAgentSubtitle:
          "すぐにトランスクリプトに書き込み、エージェントが準備できたら処理します。",
        interruptTitle: "中断して送信",
        interruptSubtitle: "現在のターンを中断し、すぐに送信します。",
        pendingTitle: "準備できるまで保留",
        pendingSubtitle:
          "メッセージを保留キューに保持し、準備ができたらエージェントが取り込みます。",
        pendingDrainModeTitle: "保留キューの処理",
        pendingDrainModeFooter:
          "エージェントが準備できるたびに1件だけ処理するか、保留キュー全体をまとめて処理するかを選びます。",
        pendingDrainMode: {
          oneAtATimeTitle: "1件ずつ処理",
          oneAtATimeSubtitle:
            "エージェントが準備できるたびに、次の保留メッセージだけを処理します。",
          drainAllTitle: "保留メッセージをすべて処理",
          drainAllSubtitle:
            "次の準備完了タイミングで、キュー内の全メッセージをまとめて処理します（従来の動作）。",
        },
        pendingDeliveryTimingTitle: "保留キューのタイミング",
        pendingDeliveryTimingFooter:
          "すでに保留中のメッセージをいつ配信するかを選びます。新しい送信は上の送信モードに従います。",
        pendingDeliveryTiming: {
          afterForegroundReadyTitle: "前面の返信後",
          afterForegroundReadySubtitle:
            "バックグラウンドの実行が続いていても、前面のターンが準備できたらキュー内のメッセージを配信します。",
          afterRuntimeIdleTitle: "すべての実行がアイドルになった後",
          afterRuntimeIdleSubtitle:
            "前面のターンが準備でき、バックグラウンド実行がアイドルになるまでキュー内のメッセージを待機させます。",
        },
        busySteerPolicyTitle: "エージェントが忙しいとき（ステア可能）",
        busySteerPolicyFooter:
          "エージェントが実行中ステアリングをサポートしている場合、すぐにステアするか、先に保留へ送るかを選びます。",
        busySteerPolicy: {
          steerImmediatelyTitle: "すぐにステア",
          steerImmediatelySubtitle:
            "すぐに送信して現在のターンをステアします（中断なし）。",
          queueForReviewTitle: "保留にキュー",
          queueForReviewSubtitle:
            "まず保留に入れ、後で「今すぐステア」で送信します。",
        },
        nonSteerablePromptTitle: 'メッセージがアクティブなターンに反映できないとき',
        nonSteerablePromptFooter: '権限モードの変更や /clear・/compact はターンの途中では適用できません。エージェントが処理中のとき、こうしたメッセージをどう扱うか選択します。',
        nonSteerablePrompt: {
            onTitle: '毎回確認',
            onSubtitle: '「中断して今すぐ送信」か「ターン終了後にキューへ」を提示します。',
            offTitle: 'オフ（従来動作）',
            offSubtitle: '変更がターン中に適用できなくても従来どおり送信します。',
        },
      },
      usageLimitRecovery: {
        title: "使用上限の回復",
        autoWaitTitle: "自動的に待機して再開",
        autoWaitEnabledSubtitle: "使用上限に達したセッションは、リセットを待って自動的に再開できます。",
        autoWaitDisabledSubtitle: "使用上限のリセットを待つ前に確認します。",
        resumePromptTitle: "再開プロンプト",
        resumePromptStandardTitle: "標準",
        resumePromptStandardSubtitle: "復旧がセッションを再開するときに通常の継続プロンプトを送信します。",
        resumePromptOffTitle: "オフ",
        resumePromptOffSubtitle: "追加の継続プロンプトを送信せずに再開します。",
        resumePromptCustomTitle: "カスタムプロンプトを送信",
        resumePromptCustomSubtitle: "回復後に独自の継続プロンプトを送信します。",
        customResumePromptTitle: "カスタム継続プロンプト",
        customResumePromptPlaceholder: "中断したところから続けてください。",
      },
      providerUsageGauge: {
        title: "プロバイダー使用量",
        footer:
          "信頼できるプロバイダー使用量があるとき、入力欄の横に表示するクォータゲージを設定します。",
        visibilityTitle: "プロバイダー使用量ゲージを表示",
        visibilityEnabledSubtitle:
          "利用可能な場合、入力欄の横にプロバイダーの残りクォータを表示します。",
        visibilityHiddenSubtitle: "入力欄のプロバイダークォータを非表示にします。",
        windowTitle: "ゲージの期間",
        windowMostConstrainedTitle: "最も制約が強い",
        windowMostConstrainedSubtitle:
          "信頼できるクォータ期間のうち残りが最も少ないものを表示します。",
        windowDailyTitle: "日次",
        windowDailySubtitle: "日次クォータ期間を優先します。",
        windowWeeklyTitle: "週次",
        windowWeeklySubtitle: "週次クォータ期間を優先します。",
        windowSessionTitle: "セッション",
        windowSessionSubtitle: "現在のセッションのクォータ期間を優先します。",
        windowPrimaryTitle: "プライマリ",
        windowPrimarySubtitle: "プロバイダーのプライマリクォータ期間を優先します。",
        windowSecondaryTitle: "セカンダリ",
        windowSecondarySubtitle: "プロバイダーのセカンダリクォータ期間を優先します。",
      },
      thinking: {
        title: "思考",
        footer:
          "思考メッセージをセッションのトランスクリプトにどう表示するかを設定します。",
          displayModeTitle: "思考の表示",
          displayMode: {
            inlineSummaryTitle: "インライン（要約）",
            inlineSummarySubtitle: "1行の要約を表示します。タップで展開します。",
            inlineTitle: "インライン（全文）",
            inlineSubtitle: "思考メッセージ全文をトランスクリプトに直接表示します。",
            toolTitle: "ツールカード",
            toolSubtitle: "思考メッセージを「推論」ツールカードとして表示します。",
            hiddenTitle: "非表示",
            hiddenSubtitle: "思考メッセージをトランスクリプトから非表示にします。",
          },
              inlineChromeTitle: "思考カード",
              inlineChromeSubtitle: "インライン思考を控えめなカード背景で表示します。",
        },
      toolRendering: {
        title: "ツール表示",
          footer:
            "セッションのタイムラインに表示するツールの詳細量を設定します。これはUI設定であり、エージェントの動作は変わりません。",
          defaultToolDetailLevelTitle: "デフォルトのツール詳細レベル",
          expandedToolDetailLevelTitle: "展開時のツール詳細レベル",
          cardTapActionTitle: "タップ動作",
          timelineChrome: {
            title: "タイムラインのツール表示スタイル",
            cardsTitle: "カード",
          cardsSubtitle:
            "詳細レベルに応じて、ツールカードに内容をインライン表示します。",
          activityFeedTitle: "ツールフィード",
          activityFeedSubtitle: "高密度表示に最適化されたコンパクトな行表示。",
        },
        cardDensity: {
          title: "カード密度",
          comfortableTitle: "ゆったり",
          comfortableSubtitle: "余白が多く、より明確に区切ります。",
          compactTitle: "コンパクト",
          compactSubtitle: "ヘッダーを詰め、パディングを減らします。",
        },
        activityFeed: {
          defaultDetailTitle: "ツールフィードの既定詳細",
          expandedDetailTitle: "ツールフィードの展開時詳細",
          tapActionTitle: "タップ動作（ツールフィード）",
          tapAction: {
            expandTitle: "展開",
            expandSubtitle: "タップでインライン詳細を展開/折りたたみします。",
            openTitle: "開く",
            openSubtitle: "タップでフルツールビュー画面を開きます。",
          },
          defaultExpandedTitle: "既定で展開",
          defaultExpandedSubtitle:
            "ツールフィードでツール行を既定で展開します。",
        },
        localControlDefaultTitle: "ローカル制御のデフォルト",
        showDebugByDefaultTitle: "デフォルトでデバッグを表示",
        showDebugByDefaultSubtitle:
          "フルツールビューで生のツールペイロードを自動展開します。",
      },
      transcript: {
        title: "トランスクリプト",
        entrySubtitle: "トランスクリプト設定を開く",
        footer:
          "チャットの表示方法とトランスクリプトの挙動をカスタマイズします。",
        codeDiffs: 'コードと差分',
        codeDiffsFooter: 'トランスクリプトでコードと差分コンテンツをどのように表示するか設定します。',
        layoutTitle: "レイアウト",
        layoutFooter:
          "シンプルな線形トランスクリプトとターン表示を選べます。",
        layoutPickerTitle: "トランスクリプトレイアウト",
        messageTimestampsTitle: "メッセージ下に日時を表示",
        messageTimestampsSubtitle:
          "各ユーザーおよびアシスタントメッセージのタイムスタンプをメッセージ下に表示します。",
        messageTimestamps: {
          hoverWebHiddenMobileTitle: "Webではホバー時、モバイルでは非表示",
          hoverWebHiddenMobileSubtitle:
            "Webではメッセージ操作と一緒にタイムスタンプを表示し、モバイルでは非表示にします。",
          hoverWebAlwaysMobileTitle: "Webではホバー時、モバイルでは常に表示",
          hoverWebAlwaysMobileSubtitle:
            "Webではメッセージ操作と一緒にタイムスタンプを表示し、モバイルでは常に表示します。",
          alwaysTitle: "常に表示",
          alwaysSubtitle: "トランスクリプトメッセージの下に常にタイムスタンプを表示します。",
          neverTitle: "表示しない",
          neverSubtitle: "トランスクリプトメッセージの下のタイムスタンプを非表示にします。",
        },
        messageActions: {
          groupTitle: 'メッセージ操作',
          groupFooter: 'トランスクリプトでのメッセージ選択と転送操作を設定します。',
          selectionEnabled: {
            title: 'メッセージ選択を有効化',
            subtitle: 'メッセージ下に選択アイコンを表示し、一括コピーまたは転送できるようにする',
          },
          sendToSessionEnabled: {
            title: 'セッションへの送信を有効化',
            subtitle: '選択したメッセージを別のセッション下書きに追加する一括送信操作を表示する',
          },
          template: {
            title: 'セッション送信用テンプレート',
            subtitle: '{{MESSAGES}}、{{SELECTED_COUNT}}、{{SOURCE_SESSION_NAME}} をプレースホルダーとして使用',
            placeholder: '{{MESSAGES}}',
            warningMissingPlaceholder: 'ヒント: {{MESSAGES}} を追加すると、選択したメッセージの挿入位置を制御できます',
          },
          bulkCopyFormat: {
            title: 'コピー形式',
            subtitle: 'コピーしたメッセージの書式',
            markdownLabeled: 'ロールラベル付き Markdown（推奨）',
            plain: 'プレーンテキスト',
          },
        },
        layout: {
          linearTitle: "線形",
          linearSubtitle: "メッセージをフラットなリストとして表示します。",
          turnsTitle: "ターン",
          turnsSubtitle: "ユーザー/アシスタントのターンにまとめます。",
        },
        toolCallsGroupTitle: "ツール呼び出しをまとめる",
        toolCallsGroupSubtitle:
          "各ターン内でツール呼び出しを「ツール呼び出し」セクションにまとめます。",
        toolCallsGroupBackgroundTitle: "ツール呼び出しグループの背景",
        toolCallsGroupBackgroundSubtitle:
          "ツールフィード表示で、ツール呼び出しグループの背景を表示します。",
        toolAppearanceTitle: "ツールの見た目",
        toolAppearanceSubtitle:
          "トランスクリプト内のツール表示をカスタマイズします。",
        motionTitle: "モーション",
        motionFooter: "トランスクリプトのアニメーションを制御します。",
        motionPickerTitle: "アニメーション",
        motion: {
          offTitle: "オフ",
          offSubtitle: "トランスクリプトのアニメーションを無効化します。",
          subtleTitle: "控えめ（既定）",
          subtleSubtitle: "新しいアクティビティに最小限の素早いモーション。",
          fullTitle: "フル",
          fullSubtitle: "より表現豊かなモーションと遷移。",
        },
        advancedMotionTitle: "詳細モーション…",
        advancedMotionSubtitle:
          "フレッシュネスとアニメーションのトグルを調整します。",
        scrollTitle: "スクロール",
        scrollFooter:
          "ピン留めスクロールと最下部ジャンプの挙動を制御します。",
          scrollPinTitle: "最下部にピン留め",
          scrollPinSubtitle: "最下部にいる間、新しいメッセージに追従します。",
          jumpToBottomTitle: "最下部へジャンプ",
          jumpToBottomButtonLabel: "最下部へ移動",
          jumpToBottomButtonNewActivityLabel: ({ count }: { count: number }) => `${count}件の新しいアクティビティ、最下部へ移動`,
            jumpToBottomSubtitle:
              "上にスクロールしている間に新しいアクティビティが来たら表示します。",
            advancedScrollTitle: "詳細スクロール…",
          advancedScrollSubtitle: "しきい値とカウンターを調整します。",
          advancedTitle: "高度な設定…",
          advancedSubtitle: "パフォーマンスとデバッグの設定。",
          advanced: {
            turnGroupingTitle: "ターンのグルーピング",
            turnGroupingFooter:
            "ターン内でツール呼び出しグループをどう形成するかを制御します。",
            performanceTitle: "パフォーマンス",
            performanceFooter: "ストリーミングとリストのパフォーマンス設定。",
            coalesceEnabledTitle: "ストリーミング更新をまとめる",
            coalesceEnabledSubtitle:
              "ソケット更新をまとめてスクロールを滑らかに保ちます。",
            coalesceWindowTitle: "まとめる間隔",
            coalesceWindowSubtitle: ({ value }: { value: string }) => `現在: ${value}ms`,
            coalesceWindowPromptTitle: "まとめる間隔（ms）",
            coalesceWindowPromptBody:
              "まとめたストリーミング更新をストアへ反映する頻度を設定します。",
            coalesceMaxBatchTitle: "最大バッチサイズ",
            coalesceMaxBatchSubtitle: ({ value }: { value: string }) => `現在: ${value}`,
            coalesceMaxBatchPromptTitle: "最大バッチサイズ",
            coalesceMaxBatchPromptBody:
              "1 回のフラッシュで適用するメッセージ数の上限を設定します。",
            streamingPartialOutputTitle: "ストリーミングの途中結果を表示",
            streamingPartialOutputSubtitle:
              "オフにすると、アシスタントのメッセージは完了後にのみ表示されます。",
            thinkingPulseStaleTitle: "思考の失効ウィンドウ",
            thinkingPulseStaleSubtitle: ({ value }: { value: string }) => `現在: ${value}ms`,
            thinkingPulseStalePromptTitle: "思考の失効ウィンドウ（ms）",
            thinkingPulseStalePromptBody:
              "更新がない場合、この時間を超えるとアクティブ思考を隠します。",
          toolCallsStrategyTitle: "ツール呼び出しのグルーピング戦略",
          toolCallsStrategy: {
            consecutiveTitle: "連続ツール（既定）",
            consecutiveSubtitle:
              "連続するツール呼び出しのみをツール呼び出しにまとめます。",
            allToolsTitle: "ターン内の全ツール",
            allToolsSubtitle:
              "ターン内の全ツール呼び出しを1つのツール呼び出しにまとめます。",
          },
            toolCallsCollapsedPreviewCountTitle: "プレビュー（折りたたみ時）",
            toolCallsCollapsedPreviewCountSubtitle: ({ value }: { value: string }) => `ツール呼び出しが折りたたまれているとき、最新の ${value} 件のツールを表示します。`,
            toolCallsCollapsedPreviewCount: {
              offTitle: "オフ",
              offSubtitle: "ツール呼び出しのヘッダーのみ表示します。",
              oneTitle: "1 ツール",
              oneSubtitle: "最新のツールをプレビュー行として表示します。",
              twoTitle: "2 ツール",
              twoSubtitle: "最新 2 件のツールをプレビュー行として表示します。",
              threeTitle: "3 ツール",
              threeSubtitle: "最新 3 件のツールをプレビュー行として表示します。",
              countTitle: ({ value }: { value: string }) => `${value} ツール`,
              countSubtitle: ({ value }: { value: string }) =>
                `最新 ${value} 件のツールをプレビュー行として表示します。`,
            },
          motionTitle: "モーション（詳細）",
          motionFooter:
            "履歴を安定させるため、アニメーションはフレッシュネスで制限されます。",
          freshnessTitle: "フレッシュネスウィンドウ",
          freshnessSubtitle: ({ value }: { value: string }) => `現在: ${value}ms`,
          freshnessPromptTitle: "フレッシュネスウィンドウ（ms）",
          freshnessPromptBody:
            "新しい項目がアニメーション対象となる時間（フレッシュ）を設定します。",
          animateNewItemsTitle: "新規項目をアニメーション",
          animateNewItemsSubtitle:
            "ストリーミングで追加された新しいメッセージ/ツールをアニメーションします。",
          animateToolExpandCollapseTitle: "ツールの展開/折りたたみをアニメーション",
          animateToolExpandCollapseSubtitle:
            "インラインの展開/折りたたみ遷移をアニメーションします。",
          animateToolExpandCollapseFreshOnlyTitle:
            "フレッシュのみ展開/折りたたみ",
          animateToolExpandCollapseFreshOnlySubtitle:
            "フレッシュなツールのみ展開/折りたたみをアニメーションします。",
          animateThinkingTitle: "思考をアニメーション",
          animateThinkingSubtitle:
            "可視の場合、ストリーミング思考メッセージをアニメーションします。",
          scrollTitle: "スクロール（詳細）",
          scrollFooter: "ピン留めしきい値とジャンプ挙動を調整します。",
          pinOffsetTitle: "ピン留めオフセットしきい値",
          pinOffsetSubtitle: ({ value }: { value: string }) => `現在: ${value}px`,
          pinOffsetPromptTitle: "ピン留めオフセットしきい値（px）",
          pinOffsetPromptBody:
            "最下部からどれだけ離れていてもピン留め扱いにするかを設定します。",
          autoFollowTitle: "ピン留め時に自動追従",
          autoFollowSubtitle:
            "ピン留め中は新しいアクティビティに自動で追従します。",
          jumpMinNewCountTitle: "ジャンプボタンの最小カウント",
          jumpMinNewCountSubtitle: ({ value }: { value: string }) => `現在: ${value}`,
          jumpMinNewCountPromptTitle: "ジャンプボタンの最小カウント",
          jumpMinNewCountPromptBody:
            "この数だけ新規項目が来た場合にのみジャンプボタンを表示します。",
          jumpAnimateScrollTitle: "最下部ジャンプをアニメーション",
          jumpAnimateScrollSubtitle:
            "最下部へジャンプする際のスクロールをアニメーションします。",
        },
      },
        toolDetailOverrides: {
          title: "ツール詳細の上書き",
          entrySubtitle: "ツールごとの上書き",
          footer:
            "特定のツールの詳細レベルを上書きします。上書きはレガシー正規化後の正規ツール名（V2）に適用されます。",
          expandedTitle: "展開時詳細の上書き",
          expandedFooter: "特定のツールの展開時詳細レベルを上書きします。",
        },
      permissions: {
        title: "権限",
        entrySubtitle: "権限設定を開く",
        footer:
          "デフォルト権限と、変更が実行中セッションにどう適用されるかを設定します。",
        promptSurfaceTitle: "権限の承認プロンプト",
        promptSurfaceFooter:
          "セッション中に承認プロンプトをどこに表示するかを選びます。",
        applyChangesFooter:
          "実行中セッションに対して権限変更をいつ適用するかを選びます。",
        backendFooter:
          "このバックエンドでセッション開始時に使うデフォルト権限モードを設定します。",
        defaultPermissionModeTitle: "デフォルト権限モード",
        promptSurface: {
          composerTitle: "入力付近（推奨）",
          composerSubtitle: "入力の近くにリッチな権限カードを表示します。",
          transcriptTitle: "トランスクリプト内",
          transcriptSubtitle: "ツールメッセージ内に権限プロンプトを表示します。",
          bothTitle: "両方",
          bothSubtitle: "入力付近とトランスクリプト内の両方に表示します。",
        },
        applyTiming: {
          immediateTitle: "すぐに適用",
          nextPromptTitle: "次のメッセージで適用",
        },
      },
      subAgentGuidanceEntry: {
        openSubtitle: "サブエージェント設定を開く",
      },
      handoff: settingsSessionHandoffTranslationExtensions.ja,
      sessionCreation: {
        title: "新規セッションモーダル",
        footer: "新規セッションモーダルの開き方と、プロジェクトのショートカットで何を反映するかを選びます。",
        modalModeTitle: "新規セッションモーダルモード",
        modalModeSimpleTitle: "シンプル",
        modalModeSimpleSubtitle: "コンパクトな入力中心のモーダルを開きます。",
        modalModeWizardTitle: "ウィザード",
        modalModeWizardSubtitle: "個別の選択欄を備えたガイド形式の設定を開きます。",
        presentationGroupTitle: "新規セッション画面",
        presentationGroupFooter: "新規セッションをルーティング画面として開くかモーダルとして開くかを選びます。",
        presentationModeTitle: "新規セッションの表示",
        presentationModeSubtitle: "新規セッションを開くときに使うルートを制御します。",
        presentationAutoTitle: "自動",
        presentationAutoSubtitle: "各プラットフォームの既定のモーダル表示を使用します。",
        presentationScreenTitle: "画面",
        presentationScreenSubtitle: "新規セッションをメイン領域で開き、コンポーザーを下部に固定します。",
        presentationModalTitle: "モーダル",
        presentationModalSubtitle: "現在のワークスペースの上に閉じられるモーダルとして新規セッションを開きます。",
        wizardModeTitle: "ウィザードモード",
        wizardModeEnabledSubtitle: "個別の選択欄を備えたガイド形式の設定を開きます。",
        wizardModeDisabledSubtitle: "コンパクトな入力中心のモーダルを使います。",
        rememberLastProjectSelectionsTitle: "プロジェクトの最後のセッション選択を記憶",
        rememberLastProjectSelectionsEnabledSubtitle:
          "プロジェクトのショートカットは、最新セッションのマシン、フォルダ、エンジン、モデル、セッションオプションを再利用します。",
        rememberLastProjectSelectionsDisabledSubtitle:
          "プロジェクトのショートカットは、プロジェクトのマシンとフォルダだけを事前選択します。",
        rememberLastEngineSelectionsTitle: "エンジンごとの最後のモデルとオプションを記憶",
        rememberLastEngineSelectionsEnabledSubtitle:
          "新規セッションでは、このアカウントで最後に選択したモデル、モード、エンジンオプションを復元します。",
        rememberLastEngineSelectionsDisabledSubtitle:
          "新規セッションは、プロジェクトショートカットまたは下書きが設定を指定しない限り既定値を使います。",
        wizardSettingsTitle: "新規セッションウィザード",
        wizardSettingsSubtitle: "各ウィザード選択欄をリストまたはドロップダウンで表示するかを選びます。",
        wizardDispositionTitle: "ウィザード配置",
        wizardDispositionSubtitle: "各ウィザード選択欄をリストまたはドロップダウンで表示するかを選びます。",
        wizardLayoutTitle: "ウィザードレイアウト",
        wizardLayoutFooter: "広い画面でウィザードセクションをどう配置するかを制御します。",
        wizardColumnsTitle: "2列レイアウト",
        wizardColumnsEnabledSubtitle: "広い画面で関連する選択欄を横に並べます。",
        wizardColumnsDisabledSubtitle: "すべてのウィザード選択欄を1列に積みます。",
        wizardPresentationTitle: "ウィザード選択欄のレイアウト",
        wizardPresentationFooter:
          "Auto は短いセクションをリストのままにし、長いセクションを検索可能なドロップダウンに切り替えます。",
        wizardPresentationAutoTitle: "Auto",
        wizardPresentationAutoSubtitle:
          "コンテンツ量に応じて Happier が最適なレイアウトを選びます。",
        wizardPresentationListTitle: "リスト",
        wizardPresentationListSubtitle: "すべての行をウィザード内に直接表示します。",
        wizardPresentationDropdownTitle: "ドロップダウン",
        wizardPresentationDropdownSubtitle: "完全な選択欄を開くコンパクトな行を表示します。",
      },
          promptPersonalization: {
              title: 'Prompt personalization',
              footer: 'Choose which built-in instructions Happier adds to new agent sessions. This does not hide options an agent already sends.',
              askAgentToRenameSessionsTitle: 'Session title updates',
              askAgentToRenameSessionsNeverTitle: 'Never',
              askAgentToRenameSessionsNeverSubtitle: 'Do not prompt agents to set session titles.',
              askAgentToRenameSessionsInitialTitle: 'At session start',
              askAgentToRenameSessionsInitialSubtitle: 'Prompt agents to set a short title from the first user message.',
              askAgentToRenameSessionsOngoingTitle: 'When the task changes',
              askAgentToRenameSessionsOngoingSubtitle: 'Prompt agents to set titles at session start and when the task changes.',
              askAgentToRenameSessionsInitialSelectedSubtitle: 'Agents are prompted to set a title at session start.',
              askAgentToRenameSessionsOngoingSelectedSubtitle: 'Agents are prompted to update titles when the task changes.',
              askAgentToRenameSessionsDisabledSubtitle: 'Agents are not prompted to set titles; manual renaming still works.',
              askAgentToSuggestReplyOptionsTitle: 'Ask the agent to suggest reply options',
              askAgentToSuggestReplyOptionsEnabledSubtitle: 'The prompt asks agents to propose quick reply options when useful.',
              askAgentToSuggestReplyOptionsDisabledSubtitle: 'The prompt does not ask agents to add quick reply options.',
          },
      defaultPermissions: {
        title: "デフォルト権限",
        footer:
          "新しいセッション開始時に適用されます。プロファイルで上書きすることもできます。",
        applyPermissionChangesTitle: "権限変更を適用",
        applyPermissionChangesImmediateSubtitle:
          "実行中セッションにすぐ適用（セッションメタデータを更新）。",
        applyPermissionChangesNextPromptSubtitle: "次のメッセージでのみ適用します。",
      },
          defaultStorage: {
      title: "既定のセッションタイプ",
              footer: "新しいセッションを、Happier セッションとして開始するか、プロバイダー直結の直接セッションとして開始するかを選択します。",
              globalTitle: "グローバル既定",
              persistedSubtitle: "新しいセッションを Happier に保存し、既定でデバイス間で同期します。",
              directSubtitle: "プロバイダーが対応している場合は、マシンに紐づく直接セッションを開始します。",
              globalSubtitle: ({ label }: { label: string }) => `グローバル既定: ${label}`,
              useGlobalDefault: "グローバル既定を使用",
              currently: ({ label }: { label: string }) => `現在: ${label}`,
          },
      replayResume: {
        title: "リプレイ再開",
        footer:
          "ベンダーの再開が利用できない場合、最近のトランスクリプトメッセージを新しいセッションへリプレイしてコンテキストにできます。",
        enabledTitle: "リプレイ再開を有効化",
        enabledSubtitleOn:
          "ベンダー再開が利用できない場合にリプレイ再開を提案します。",
        enabledSubtitleOff: "リプレイ再開を提案しません。",
        strategyTitle: "リプレイ戦略",
        strategy: {
          recentTitle: "最近のメッセージ",
          recentSubtitle:
            "最も最近のトランスクリプトメッセージのみを使用します。",
          summaryRecentTitle: "要約 + 最近（実験的）",
          summaryRecentSubtitle:
            "短い要約と最近のメッセージを含めます（ベストエフォート）。",
        },
        summaryRunner: {
          title: "要約ランナー（オンデマンド）",
          backendTitle: "バックエンド",
          backendPlaceholder: "claude（例）",
          searchBackendsPlaceholder: "バックエンドを検索…",
          modelTitle: "モデル（LLM）",
          modelPlaceholder: "default（例）",
          searchModelsPlaceholder: "モデルを検索…",
          notSet: "未設定",
          customTitle: "カスタム",
          customBackendIdSubtitle: "バックエンドIDを入力（例: claude）。",
          customModelIdSubtitle: "モデルIDを入力（例: default）。",
        },
        recentMessagesTitle: "含める最近メッセージ",
        recentMessagesPlaceholder: "16",
        maxSeedCharsTitle: "リプレイ seed 上限（文字数）",
        maxSeedCharsPlaceholder: "50000",
      },
      toolDetailLevel: {
        titleOnlyTitle: "タイトルのみ",
        titleOnlySubtitle:
          "タイムラインにツール名のみを表示します（サブタイトルなし、本文なし）。",
        compactTitle: "コンパクト",
        compactSubtitle: "タイムラインにツール名＋短いサブタイトルを同じ行に表示します（本文なし）。",
        summaryTitle: "要約",
        summarySubtitle: "タイムラインにコンパクトで安全な要約を表示します。",
        fullTitle: "詳細",
        fullSubtitle: "タイムラインに詳細をインラインで表示します。",
        defaultTitle: "デフォルト",
        defaultSubtitle: "グローバルのデフォルトを使用します。",
          styleDefaultTitle: "デフォルト（推奨）",
          styleDefaultSubtitle: "カード: 要約。ツールフィード: コンパクト。",
          expandedStyleDefaultTitle: "デフォルト（推奨）",
          expandedStyleDefaultSubtitle: "カード: 詳細。ツールフィード: 要約。",
      },
      terminalConnect: {
        title: "ターミナル接続",
        legacySecretExportTitle: "旧シークレットのエクスポート（互換）",
        legacySecretExportEnabledSubtitle:
          "有効：旧アカウントシークレットをターミナルへエクスポートし、古いターミナルが接続できるようにします。推奨されません。",
        legacySecretExportDisabledSubtitle:
          "無効（推奨）：コンテンツキーのみでターミナルをプロビジョニングします（Terminal Connect V2）。",
      },
  },
  windowsRemoteSessionLaunchMode: {
    hidden: "非表示",
    shortHidden: "非表示",
    hiddenSubtitle: "ターミナルウィンドウを開かず、バックグラウンドでセッションを開始します。",
    windowsTerminal: "Windows Terminal",
    shortWindowsTerminal: "WT",
    windowsTerminalSubtitle: "共有 Windows Terminal ウィンドウのタブとしてセッションを開きます。",
    console: "コンソール",
    shortConsole: "コンソール",
    consoleSubtitle: "標準の Windows コンソールウィンドウでセッションを開きます。",
  },
  settingsVoice: {
    ...voiceDiagnosticsConsentTranslations.ja,
    intents: {
      dictation: { title: '音声入力', subtitle: '1回の発話を入力欄のテキストに変換します。' },
      conversations: { title: '音声会話', subtitle: 'プロバイダーを選び、基本設定を行います。' },
      privacy: { title: 'プライバシーとデータ', subtitle: 'プロバイダーの処理、コンテキスト共有、音声履歴を確認します。', processingTitle: 'プロバイダーによる処理' },
      advanced: { title: '詳細設定', subtitle: '音声UI、実行マシン、診断を設定します。' },
    },
    history: {
      title: '音声履歴',
      sectionTitle: '履歴',
      sectionFooter: '対象なしおよびグローバル音声会話の文字起こしを確認または削除します。',
      entryTitle: '音声履歴',
      entrySubtitle: '保存された音声文字起こしを検索、書き出し、または消去します。',
      searchTitle: '読み込み済み履歴を検索',
      searchFooter: 'この端末ですでに復号された音声メッセージを検索します。',
      searchPlaceholder: '文字起こしまたはプロバイダーを検索',
      searchAccessibilityLabel: '音声履歴を検索',
      actionsTitle: '履歴の操作',
      loading: '音声履歴を読み込んでいます…',
      emptyTitle: '音声履歴はまだありません',
      emptyBody: 'スタンドアロンおよびグローバル音声の文字起こしは、保存後にここに表示されます。',
      noResultsTitle: '読み込み済み履歴に一致する項目はありません',
      noResultsBody: '別の検索を試すか、古いメッセージを読み込んでください。',
      loadOlderTitle: '古いメッセージを読み込む',
      loadOlderSubtitle: 'この端末で音声履歴の前のページを復号します。',
      loadOlderFooter: '古いメッセージは、読み込むか消去するまでサーバーに残ります。',
      loadingOlder: '古いメッセージを読み込んでいます…',
      loadOlderFailed: '古い音声履歴を読み込めませんでした。',
      exportTitle: '音声履歴を書き出す',
      exportSubtitle: '残りの履歴を上限内で読み込み、JSONとして保存します。',
      exporting: '書き出しを準備しています…',
      exportSucceeded: '音声履歴の書き出し準備ができました。',
      exportFailed: '音声履歴を書き出せませんでした。',
      clearTitle: '音声履歴を消去',
      clearSubtitle: 'このアカウントのスタンドアロン音声履歴全体を削除します。',
      clearing: '音声履歴を消去しています…',
      clearConfirmTitle: '音声履歴を消去しますか？',
      clearConfirmBody: 'このアカウントのスタンドアロン音声履歴全体が完全に削除されます。この操作は元に戻せません。',
      clearConfirmAction: '履歴を消去',
      clearSucceeded: '音声履歴を消去しました。',
      clearActiveCall: '音声履歴を消去する前に音声を終了してください。',
      clearFailed: '音声履歴を消去できませんでした。',
      errorTitle: '音声履歴を利用できません',
      errorBody: 'このアカウントの暗号化された履歴を読み込めませんでした。接続を確認して再試行してください。',
      upgradeRequiredTitle: '音声履歴を読み込むには更新が必要です',
      upgradeRequiredBody: 'このサーバーは、このアカウントで使用されている暗号化履歴形式をサポートしていません。サーバー上の Happier を更新してから、再読み込みしてください。',
      supersededTitle: 'アクティブなアカウントが変更されました',
      supersededBody: '別のアカウントを使用する前に要求を停止しました。安全に続行するには再読み込みしてください。',
      retry: '再試行',
      roleYou: 'あなた',
      roleAssistant: 'アシスタント',
    },
    dictation: {
      title: '音声入力',
      footer: '入力欄のマイクで使う音声認識プロバイダーを選びます。明示的に連携しない限り、会話用の音声設定とは別です。',
      provider: '音声認識プロバイダー',
      providerSubtitle: '音声入力専用のプロバイダーを選ぶか、ローカル音声に明示的に合わせます。',
      sameAsLocal: 'ローカル音声と同じ',
      sameAsLocalSubtitle: 'ローカル音声の音声認識設定に明示的に従います。',
      language: '音声入力の言語',
      languageSubtitle: '音声入力だけに使う任意の言語ヒントです。',
      readiness: {
        title: '音声入力の準備状況',
        footer: '保存済み設定と現在のマシン／モデル状態だけを確認します。マイクを開いたり、音声を送信したり、プロバイダーへ接続したりしません。',
        check: '設定を確認',
        checkSubtitle: '選択した音声入力設定を受動的に検証します。',
        result: '設定状態',
        ready: '音声入力を使用できます。',
        needsSetup: '設定が完了していません。選択したプロバイダーの詳細を確認してください。',
        installing: '必要な音声モデルをインストール中です。',
        incompatible: '選択したプロバイダーはこのプラットフォームまたは設定に対応していません。',
        unavailable: '現在のローカル情報から準備状況を確認できませんでした。',
      },
    },
    setupCheck: {
      title: 'プロバイダーの準備状況',
      footer: '保存済み設定と現在のローカル準備情報だけを確認します。マイクを開いたり、音声機能を開始したり、音声を送信したり、プロバイダーへ接続したりしません。',
      check: '設定を確認',
      checkSubtitle: '選択した音声プロバイダー設定を受動的に確認します。',
      result: '設定状態',
    },
    // Voice settings screen
    modeTitle: "音声",
    modeDescription:
      "音声機能を設定します。音声を完全に無効にするか、Happier Voice（サブスクリプションが必要）を使用するか、ご自身のElevenLabsアカウントを使用できます。",
    mode: {
      off: "オフ",
      offSubtitle: "すべての音声機能を無効化",
      happier: "Happier Voice",
      happierSubtitle: "Happier Voiceを使用（サブスクリプションが必要）",
      local: "ローカル OSS 音声",
      localSubtitle: "ローカルの OpenAI 互換 STT/TTS エンドポイントを使用",
      byo: "自分のElevenLabsを使用",
      byoSubtitle: "自分のElevenLabs APIキーとエージェントを使用",
    },
    realtimeProviders: {
      ...voiceProviderPrivacyTranslations.ja,
      operationFailed: '設定を更新できませんでした。もう一度お試しください。',
      operationFailedUnsaved: '設定を更新できませんでした。変更は保存されていません。',
      operationFailedVoiceNotFound: '選択した音声は接続中のアカウントで利用できません。別の音声を選んでから、この操作をもう一度実行してください。変更は保存されていません。',
      operationFailedStage: ({ stage }: { stage: string }) => `失敗したステップ: ${stage}`,
      operationFailedStatus: ({ status }: { status: number }) => `プロバイダーの応答: HTTP ${status}`,
      codex: {
        sectionTitle: "Codex Live アカウント",
        accountTitle: "グローバル音声アカウント",
        accountSubtitle: "グローバル Codex Voice が使用する接続済みサービスのアカウントまたはアカウントグループを指定します。ダイレクト音声は常に開いているセッションを使用します。",
        privacyDisclosure: "音声と Codex Live の会話は、WebRTC を使用してこのデバイスから OpenAI に送信されます。選択した Codex セッションと接続サービスのアカウントは、選択したマシン経由で動作します。会話を継続して応答を読み上げるため、OpenAI は限定された起動時およびセッションのコンテキストと委任された Codex の結果を受信する場合があります。Happier のサーバーとリレーは Codex Live の音声を中継しませんが、Happier の daemon/app-server は引き続きシグナリング、セッションのライフサイクル、委任、ツール、権限制御を処理します。プロバイダーが運用するネットワークリレーが通信に参加する場合があります。Codex または OpenAI は、選択したアカウントとプロバイダーのポリシーに従い、開発者向け指示、リアルタイム会話資料、関連診断をプロバイダー固有のランタイムストレージに保持する場合があります。Happier はそのプロバイダー固有データを削除または書き換えません。",
      },
    },
    ui: {
      title: "音声サーフェス",
      footer: "音声イベントの画面内フィード（セッションには書き込みません）。",
      activityFeedEnabled: "音声アクティビティフィードを有効化",
      activityFeedEnabledSubtitle: "音声利用中に最近の音声イベントを表示",
      activityFeedAutoExpandOnStart: "開始時に自動で展開",
      activityFeedAutoExpandOnStartSubtitle: "音声開始時にフィードを自動で展開します",
      orbEnabled: "フローティング音声オーブ",
      orbEnabledSubtitle: "このデバイスでドラッグできる音声コンパニオンを表示します。音声はサイドバーと入力欄から引き続き利用できます。",
      scopeTitle: "デフォルトの音声スコープ",
      scopeSubtitle: "デフォルトで音声をグローバル（アカウント）にするか、セッションに紐づけるかを選択します。",
      scopeGlobal: "グローバル（アカウント）",
      scopeGlobalSubtitle: "移動しても音声を継続し、セッションをターゲットできます",
      scopeSession: "セッション",
      scopeSessionSubtitle: "音声は開始したセッション内で操作します",
      surfaceLocationTitle: "表示場所",
      surfaceLocationSubtitle: "音声サーフェスを表示する場所を選択します。",
      surfaceLocation: {
        autoTitle: "自動",
        autoSubtitle: "グローバルはサイドバー、セッションはセッション内に表示します。",
        sidebarTitle: "サイドバー",
        sidebarSubtitle: "サイドバーに表示します。",
        sessionTitle: "セッション",
        sessionSubtitle: "セッションの入力欄の上に表示します。",
      },
      updates: {
        title: "セッション更新",
        footer: "音声アシスタントが受け取る背景コンテキストを制御します。",
        activeSessionTitle: "ターゲットセッション",
        activeSessionSubtitle: "ターゲット中のセッションに対して自動送信する内容。",
        otherSessionsTitle: "他のセッション",
        otherSessionsSubtitle: "ターゲット外のセッションに対して自動送信する内容。",
        level: {
          noneTitle: "なし",
          noneSubtitle: "自動更新を送信しません。",
          activityTitle: "アクティビティのみ",
          activitySubtitle: "件数とタイムスタンプのみ送信します。",
          summariesTitle: "要約",
          summariesSubtitle: "短い安全な要約（メッセージ本文なし）。",
          snippetsTitle: "スニペット",
          snippetsSubtitle: "短いメッセージ断片（プライバシーリスク）。",
        },
        snippetsMaxMessagesTitle: "最大メッセージ数",
        snippetsMaxMessagesSubtitle: "1回の更新に含めるメッセージ数の上限。",
        includeUserMessagesInSnippetsTitle: "自分のメッセージを含める",
        includeUserMessagesInSnippetsSubtitle: "有効にするとスニペットにあなたのメッセージも含まれます。",
        otherSessionsSnippetsModeTitle: "他セッションのスニペット",
        otherSessionsSnippetsModeSubtitle: "他セッションのスニペット許可条件を制御します。",
        otherSessionsSnippetsMode: {
          neverTitle: "しない",
          neverSubtitle: "他セッションのスニペットを無効化。",
          onDemandTitle: "要求時のみ",
          onDemandSubtitle: "ユーザーが明示的に求めたときのみ許可します。",
          autoTitle: "自動",
          autoSubtitle: "自動で他セッションのスニペットを送信します（ノイズ多）。",
        },
      },
    },
    byo: {
      title: "自分のElevenLabsを使用",
	      agentReuseDialog: {
	        title: "Happier エージェントは既に存在します",
	        messageWithId: ({ name, id }: { name: string; id: string }) =>
	          `既存の ElevenLabs エージェント（「${name}」、id: ${id}）が見つかりました。\n\n更新しますか？それとも新しく作成しますか？`,
	        messageNoId: ({ name }: { name: string }) =>
	          `既存の ElevenLabs エージェント（「${name}」）が見つかりました。\n\n更新しますか？それとも新しく作成しますか？`,
	        actions: {
	          createNew: "新規作成",
	          updateExisting: "既存を更新",
	        },
	      },
      configured: "設定済み。音声使用量はElevenLabsアカウントに請求されます。",
      notConfigured:
        "サブスクリプションなしで音声を使用するには、ElevenLabsのAPIキーとエージェントIDを入力してください。",
      createAccount: "ElevenLabs アカウントを作成",
      createAccountSubtitle:
        "APIキーを作る前にサインアップ（またはサインイン）してください",
      openApiKeys: "ElevenLabs の API キーを開く",
      openApiKeysSubtitle: "ElevenLabs → Developers → API Keys → Create API key",
      apiKeyHelp: "APIキーの作り方",
      apiKeyHelpSubtitle:
        "ElevenLabs APIキーの作成とコピー手順",
      apiKeyHelpDialogTitle: "ElevenLabs APIキーを作成",
      apiKeyHelpDialogBody:
        "Open ElevenLabs → Developers → API Keys → Create API key → Copy the key.",
      autoprovCreate: "Happier エージェントを作成",
      autoprovCreateSubtitle:
        "APIキーを使ってElevenLabsアカウントにHappierエージェントを作成・設定します",
      autoprovUpdate: "エージェントを更新",
      autoprovUpdateSubtitle:
        "エージェントを最新のHappierテンプレートに更新します",
      autoprovCreated: ({ agentId }: { agentId: string }) =>
        `作成したエージェント: ${agentId}`,
      autoprovUpdated: "エージェントを更新しました",
      autoprovFailed:
        "エージェントの作成/更新に失敗しました。もう一度お試しください。",
      agentId: "エージェントID",
      agentIdSet: "設定済み",
      agentIdNotSet: "未設定",
      agentIdTitle: "ElevenLabs エージェントID",
      agentIdDescription:
        "ElevenLabs ダッシュボードにあるエージェントIDを入力してください。",
      agentIdPlaceholder: "agent_...",
      apiKey: "APIキー",
      apiKeySet: "設定済み",
      apiKeyNotSet: "未設定",
      apiKeyTitle: "ElevenLabs APIキー",
      apiKeyDescription:
        "ElevenLabsのAPIキーを入力してください。これは端末内に暗号化して保存されます。",
      apiKeyPlaceholder: "xi-api-key",
      voiceSearchPlaceholder: "ボイスを検索",
      voiceGroupTitle: "ボイス",
      voiceGroupFooter:
        "ElevenLabs エージェントの話し方を選択します。変更はエージェント更新後に適用されます。",
      provisioningGroupTitle: "エージェントのプロビジョニング",
      provisioningGroupFooter:
        "声/チューニングを変更したら、「エージェントを更新」をタップしてElevenLabsに反映してください。",
      realtime: {
        call: {
          title: "通話",
          welcome: {
            title: "ウェルカムメッセージ",
            subtitle: "通話開始時の任意の挨拶です。",
            detail: {
              off: "オフ",
              immediate: "即時",
              onFirstTurn: "初回発話時",
            },
            options: {
              offSubtitle: "挨拶なし。",
              immediateSubtitle: "接続したらすぐに挨拶します。",
              onFirstTurnSubtitle: "最初の返答の冒頭で挨拶します。",
            },
          },
        },
        voicePicker: {
          title: "声",
          subtitle: "返信に使う ElevenLabs の声を選択します。",
          missingApiKeyTitle: "声を読み込むには API キーを追加してください",
          loadingTitle: "声を読み込み中…",
          errorTitle: "声の読み込みに失敗しました",
          errorSubtitle: "API キーを確認して再試行してください。",
        },
        modelPicker: {
          title: "モデル",
          subtitle: "任意: ElevenLabs TTS のモデル ID を上書きします。",
          detailAuto: "自動",
          options: {
            autoTitle: "自動",
            autoSubtitle: "ElevenLabs の既定モデルを使用します。",
            multilingualV2Subtitle: "一般的な既定（多言語）。",
            turboV2Subtitle: "低レイテンシ（プランで利用可能な場合）。",
            turboV25Subtitle: "Turbo 2.5（利用可能な場合）。",
            customTitle: "カスタム…",
            customSubtitle: "モデル ID を入力",
          },
          prompt: {
            title: "モデルID",
            body: "ElevenLabs のモデルIDを入力するか、空欄で既定を使用します。",
          },
        },
        voiceSettings: {
          default: "既定",
          stability: {
            title: "安定性",
            subtitle: "0–1。空欄で既定。",
            promptTitle: "安定性（0–1）",
            promptBody: "0〜1 の数値を入力してください。空欄で既定を使用します。",
            invalid: "0〜1 の数値を入力してください。",
          },
          similarityBoost: {
            title: "類似度ブースト",
            subtitle: "0–1。空欄で既定。",
            promptTitle: "類似度ブースト（0–1）",
            promptBody: "0〜1 の数値を入力してください。空欄で既定を使用します。",
            invalid: "0〜1 の数値を入力してください。",
          },
          speed: {
            title: "速度",
            subtitle: "0.7–1.2。空欄で既定。",
            promptTitle: "速度（0.7–1.2）",
            promptBody: "0.7〜1.2 の数値を入力してください。空欄で既定を使用します。",
            invalid: "0.7〜1.2 の数値を入力してください。",
          },
        },
        getStartedTitle: "はじめに",
      },
      apiKeySaveFailed: "APIキーの保存に失敗しました。もう一度お試しください。",
      disconnect: "切断",
      disconnectSubtitle: "このデバイスに保存されたElevenLabsの認証情報を削除",
      disconnectTitle: "ElevenLabs を切断",
      disconnectDescription:
        "このデバイスに保存されたElevenLabsのAPIキーとエージェントIDを削除します。",
      disconnectConfirm: "切断",
    },
    externalCredentials: {
      apiKeyTitle: "APIキー",
      promptTitle: "この音声プロバイダーを接続",
      promptDescription: "プロバイダーのAPIキーを貼り付けます。キーはアカウントに保存され、このプラグインが宣言したプロバイダーのエンドポイントにのみ送信されます。プラグインのランタイムコードには渡されません。",
      footer: "保存済みのキーはアカウントに保存されます。ホストが宣言済みのプロバイダーエンドポイントへ仲介送信し、プラグインコードは操作結果のみを受け取ります。",
      rawPromptDescription: "プロバイダーのAPIキーを貼り付けます。このプロバイダーが宣言したランタイムのプラグインコードは、選択した認証情報を直接受け取り、使用またはコピーできます。",
      rawFooter: "生の認証情報アクセスでは、宣言されたランタイムのプラグインコードが選択した認証情報を直接受け取り、使用またはコピーできます。使用前にアクセスを確認してください。",
      rawCredentialAccessReviewBody: ({ pluginId, localId, credentialSlot, source, realm, phase }: { pluginId: string; localId: string; credentialSlot: string; source: string; realm: string; phase: string }) =>
        `${pluginId}/${localId} のプラグインコードは、${realm} ランタイムで ${phase} 中に ${credentialSlot} 用の選択済み ${source} 認証情報を受け取ります。使用またはコピーできます。`,
      ready: "APIキーを保存しました",
      missing: "APIキーが必要です",
      unavailable: "認証情報を設定できません",
    },
    local: {
      voiceCredential: {
        useSavedSecretTitle: "保存済みのシークレットを使う",
        useSavedSecretSubtitle: "このアカウントに保存済みのキーを選びます。",
      },
      title: "ローカル OSS 音声",
      footer:
        "speech-to-text (STT) と text-to-speech (TTS) のための OpenAI 互換エンドポイントを設定します。",
      localhostWarning:
        '注意: "localhost" と "127.0.0.1" は通常スマホでは動きません。PC の LAN IP かトンネルを使用してください。',
      notSet: "未設定",
      apiKeySet: "設定済み",
      apiKeyNotSet: "未設定",
      baseUrlPlaceholder: "http://192.168.1.10:8000/v1",
      apiKeyPlaceholder: "任意",
      apiKeySaveFailed: "APIキーの保存に失敗しました。もう一度お試しください。",
      googleCloudTts: {
        provider: {
          title: "Google Cloud 音声合成（Text-to-Speech）",
          subtitle:
            "Google Cloud の API キーを使って音声を合成します。",
          detail: "Google Cloud（GCP）",
        },
        common: {
          default: "既定",
        },
        apiKey: {
          title: "Google Cloud APIキー",
          promptTitle: "Google Cloud APIキー",
          promptBody:
            "Text-to-Speech API を有効化した API キーを作成してください。任意: このアプリにキーを制限できます（iOS bundle id / Android package+SHA1）。",
        },
        androidCertSha1: {
          title: "Android 証明書 SHA-1（任意）",
          subtitle:
            "API キーを Android アプリに制限する場合のみ必要です。",
          promptTitle: "Android 証明書 SHA-1",
          promptBody: "例: AA:BB:CC:...（署名証明書から）。",
        },
        language: {
          title: "言語",
          subtitle: "ボイス一覧の任意フィルター。",
          searchPlaceholder: "言語を検索",
          allTitle: "すべて",
          allSubtitle: "すべての言語のボイスを表示します。",
        },
        speakingRate: {
          title: "話速",
          subtitle: "0.25–4.0（空欄でボイス既定）。",
          promptTitle: "話速",
          promptBody:
            "話速を設定します（0.25–4.0）。空欄で既定を使用します。",
        },
        pitch: {
          title: "ピッチ",
          subtitle: "-20–20（空欄でボイス既定）。",
          promptTitle: "ピッチ",
          promptBody:
            "ピッチを設定します（-20–20）。空欄で既定を使用します。",
        },
        voice: {
          title: "声",
          subtitle: "Google Cloud の声を選択します。",
          searchPlaceholder: "声を検索",
          selectPrompt: "選択…",
          setApiKeyPrompt: "APIキーを設定",
          loadingTitle: "声を読み込み中…",
        },
        format: {
          title: "形式",
          subtitle: "MP3 は小さめ、WAV は無圧縮です。",
          mp3Subtitle: "出力が小さく、互換性が高いです。",
          wavSubtitle: "出力が大きく、無圧縮です。",
        },
        alerts: {
          missingApiKey: "Google Cloud APIキーがありません。",
          missingVoice: "先に Google Cloud の声を選択してください。",
        },
      },
      googleGeminiStt: {
        provider: {
          title: "Google Gemini（音声）",
          subtitle: "Gemini のマルチモーダルモデルで音声を文字起こしします。",
          detail: "Gemini（Google）",
        },
        apiKey: {
          title: "Gemini API キー",
          promptTitle: "Gemini API キー",
          promptBody: "Google AI Studio（Gemini API）で API キーを作成してください。",
        },
        model: {
          title: "Gemini モデル",
          subtitle: "文字起こしに使用する Gemini モデルを選択します。",
          searchPlaceholder: "モデルを検索",
          customTitle: "カスタムモデル ID…",
          customSubtitle: "モデル名を手動で入力します。",
          loadingModelsTitle: "モデルを読み込み中…",
          promptTitle: "Gemini モデル",
          promptBody: "例: gemini-2.5-flash",
        },
        language: {
          title: "言語",
          subtitle: "文字起こし精度を向上させるための任意のヒントです。",
          searchPlaceholder: "言語を検索",
          autoTitle: "自動",
          autoSubtitle: "言語ヒントを提供しません。",
        },
      },
      kokoro: {
        common: {
          default: "既定",
          none: "なし",
        },
        runtime: {
          title: "Kokoro ランタイム",
          unsupportedSubtitle:
            "このデバイス/ランタイムでは Kokoro を使用できません。",
          unavailableDetail: "利用不可",
        },
        manifest: {
          title: "モデルパックのマニフェスト",
          subtitle:
            "既定では Happier のモデルパックを使用します（EXPO_PUBLIC_HAPPIER_MODEL_PACK_MANIFESTS で上書き可能）。",
          detailResolved: "解決済み",
          detailMissing: "見つかりません",
        },
        assetPack: {
          title: "Kokoro モデルパック",
          subtitleNative: "Kokoro で使用するアセットパックを選択します。",
          subtitleWeb: "Kokoro で使用するランタイム構成を選択します。",
        },
        model: {
          title: "Kokoro モデル",
          subtitleNative:
            "端末内合成を有効にするため、必要なファイルをダウンロードします。",
          subtitleWeb:
            "必要に応じてダウンロードします。WebAssembly（ベータ）を使用します。",
        },
        modelStatus: {
          downloading: "ダウンロード中…",
          downloadingPrefix: "ダウンロード中",
          ready: "準備完了",
          error: "エラー",
          notDownloaded: "未ダウンロード",
        },
        removeAssets: {
          title: "Kokoro のアセットを削除",
          subtitle:
            "ダウンロード済みの Kokoro ファイルを削除して容量を空けます。",
          detailRemove: "削除",
          confirmTitle: "Kokoro のアセットを削除しますか？",
          confirmBody:
            "このデバイスから、ダウンロード済みの Kokoro ファイルを削除します。",
          confirmButton: "削除",
        },
        updates: {
          title: "モデル更新を確認",
          subtitle: "新しいモデルパックが利用可能か手動で確認します。",
          check: "確認",
          upToDate: "最新",
          updateAvailable: "更新あり",
        },
        alerts: {
          runtimeUnsupported: {
            body: "このデバイス/ランタイムでは Kokoro を使用できません。",
          },
          missingManifest: {
            title: "マニフェスト URL がありません",
            body: "モデルパックのマニフェスト URL を解決できません。EXPO_PUBLIC_HAPPIER_MODEL_PACK_MANIFESTS（または旧 Kokoro の環境変数）を確認してください。",
          },
          notInstalledTitle: "未インストール",
          notInstalledBody:
            "更新確認を有効にするには、まずモデルパックをダウンロードしてください。",
          upToDateTitle: "最新",
          upToDateBody: "このモデルパックの更新はありません。",
          updateAvailableTitle: "更新あり",
          updateAvailableBody: ({ remoteBuild }: { remoteBuild: string | null }) =>
            `このモデルパックの最新バージョンを今すぐダウンロードしますか？${remoteBuild ? `\n\nリモートビルド: ${remoteBuild}` : ""}`,
          updatedTitle: "更新しました",
          updatedBody: "モデルパックを更新しました。",
          updateFailedTitle: "更新に失敗しました",
          updateFailedBody: ({ message }: { message: string }) =>
            `モデルパックを更新できませんでした。\n\n${message}`,
        },
        voice: {
          title: "音声",
          subtitleNative: "Kokoro の音声を選択します。",
          searchPlaceholder: "音声を検索",
          titleWeb: "Kokoro の音声",
          subtitleWeb: "返信に使用する端末内音声を選択します。",
          loadingVoicesTitle: "音声を読み込み中…",
        },
        speed: {
          title: "速度",
          subtitle: "読み上げ速度を調整します（0.5〜2.0）。",
        },
        web: {
          warmingUp: "準備中…",
          clearCache: {
            confirmTitle: "Kokoro のキャッシュを消去しますか？",
            confirmBody:
              "このデバイスから、ダウンロード済みの Kokoro モデルと音声ファイルを削除します。",
            confirmButton: "消去",
          },
          cacheDetail: {
            modelFiles: "モデルファイル",
            voices: "音声",
          },
          cache: {
            title: "Kokoro キャッシュ",
            subtitle:
              "このデバイスの Kokoro ダウンロードファイルを管理します。",
          },
        },
      },
      localNeuralStt: {
        modelPack: {
          title: "モデルパック",
          subtitle: "ストリーミングSTT用モデルパックID。",
        },
        modelFiles: {
          title: "モデルファイル",
          subtitle:
            "端末内ストリーミングSTTを有効にするために必要なファイルをダウンロードします。",
        },
        removeModelFiles: {
          title: "モデルファイルを削除",
          subtitle:
            "ダウンロード済みのモデルファイルを削除して容量を空けます。",
          confirmTitle: "モデルファイルを削除しますか？",
          confirmBody:
            "このデバイスからダウンロード済みのSTTモデルパックを削除します。",
        },
        status: {
          installed: "インストール済み",
          installedWithBuild: ({ build }: { build: string }) =>
            `インストール済み • ${build}`,
          notInstalled: "未インストール",
        },
        language: {
          title: "言語",
          subtitle: "BCP-47 言語タグ（任意）",
          promptTitle: "言語",
          promptBody: "BCP-47 の言語タグを入力してください（例: en, en-US）。",
        },
        alerts: {
          downloadFailedTitle: "ダウンロードに失敗しました",
          downloadFailedBody: ({ message }: { message: string }) =>
            `このモデルパックをダウンロードできませんでした。\n\n${message}`,
          notInstalledTitle: "未インストール",
          notInstalledBody:
            "更新チェックを有効にするには、先にモデルパックをダウンロードしてください。",
          upToDateBody: "このモデルパックに利用可能な更新はありません。",
          updateAvailableBody: ({ remoteBuild }: { remoteBuild: string | null }) =>
            `このモデルパックの最新バージョンを今すぐダウンロードしますか？${remoteBuild ? `\n\nリモートビルド: ${remoteBuild}` : ""}`,
          updatedTitle: "更新完了",
          updatedBody: "モデルパックを更新しました。",
          updateFailedTitle: "更新に失敗しました",
          updateFailedBody: ({ message }: { message: string }) =>
            `このモデルパックを更新できませんでした。\n\n${message}`,
        },

        provider: {
          title: "ローカルニューラル（ベータ）",
          subtitle:
            "Web では daemon 経由の STT を使用し、対応環境ではネイティブ Sherpa ストリーミングパックも利用できます。",
          detail: "Sherpa エンジン",
        },},
      executionMachine: {
        groupTitle: "ローカル音声の実行環境",
        groupFooter: "ローカル音声、モデル管理、音声エージェントを実行するマシンを選択します。",
        title: "実行マシン",
        fallbackSubtitle: "ローカル音声に使用するマシンを選択します。",
        autoTitle: "自動",
        autoSubtitle: "最近の使用状況から利用可能なマシンを選択します。",
        onlineLabel: "オンライン",
        offlineLabel: "オフライン",
        unknownMachineLabel: "不明なマシン",
      },
      conversationMode: "会話モード",
      conversationModeSubtitle:
        "セッションへ直接、またはメディエーターで明示的にコミット",
      conversation: {
        mode: {
          voiceAgentSubtitle:
            "音声エージェントを使用（明示的コミット、ツール制御）。",
          directTitle: "ダイレクトセッション",
          directSubtitle: "アクティブなセッションへ直接話しかけます。",
        },
        handsFree: {
          title: "ハンズフリー",
          enableTitle: "ハンズフリーを有効化",
          silenceTitle: "無音タイムアウト（ms）",
          minSpeechTitle: "最小発話（ms）",
        },
        customBackendIdSubtitle: "カスタム backend ID を入力します。",
        searchBackendsPlaceholder: "backend を検索",
        searchModelsPlaceholder: "モデルを検索",
        machineAutoSubtitle:
          "最近の利用状況に基づいて自動でマシンを選択します。",
        rootSessionPolicy: {
          title: "ルートセッション方針",
          fallbackSubtitle: "方針を選択してください。",
          singleTitle: "単発",
          singleSubtitle: "毎回新しいルートセッションを作成します。",
          keepWarmTitle: "ウォーム維持",
          keepWarmSubtitle:
            "可能ならウォームなルートセッションを再利用します。",
          maxWarmRootsTitle: "最大ウォームルート数",
          maxWarmRootsSubtitle:
            "保持するウォームなルートセッション数を制限します。",
        },
        persistence: {
          title: "トランスクリプトの永続化",
          ephemeralTitle: "一時",
          ephemeralSubtitle:
            "セッション間で音声エージェントの状態を保存しません。",
          persistentTitle: "永続",
          persistentSubtitle:
            "セッション間で音声エージェントの状態を保存します（再開可）。",
        },
        resetVoiceAgent: {
          title: "音声エージェント状態をリセット",
          subtitle: "音声エージェントの永続状態を消去します。",
          confirmBody:
            "保存された音声エージェントの状態を消去します。元に戻せません。",
        },
        agentSettings: {
          title: "音声エージェント",
        },
        backend: {
          daemonSubtitle:
            "Happier backend を使用し、provider resume をサポートします。",
          openAiSubtitle:
            "OpenAI 互換の HTTP エンドポイントに接続します。",
        },
        agentMachine: {
          title: "エージェントのマシン",
          fallbackSubtitle:
            "音声エージェントを実行する場所を選択します。",
          stayInVoiceHomeTitle: "voice home に留める",
          stayInVoiceHomeEnabledSubtitle:
            "voice home マシンでエージェントを動かし続けます。",
          stayInVoiceHomeDisabledSubtitle:
            "エージェントがセッションのマシンに追従できるようにします。",
          allowTeleportTitle: "テレポートを許可",
          teleportEnabledSubtitle:
            "必要に応じてエージェントを別マシンへ移動できます。",
          teleportDisabledSubtitle: "テレポート無効。",
        },
        machineRecovery: {
          switchTitle: "音声マシンを利用できません",
          switchBody: ({ currentMachine, nextMachine }: { currentMachine: string; nextMachine: string }) =>
            `現在の音声マシン（${currentMachine}）は利用できません。\n\n音声を ${nextMachine} に切り替えますか？`,
          switchAction: "マシンを切り替える",
          replayTitle: "会話を引き継ぎますか？",
          replayBody: ({ nextMachine }: { nextMachine: string }) =>
            `${nextMachine} で新しく始めることも、前のマシンから最近の音声コンテキストを再生して切り替えることもできます。`,
          replayAction: "切り替えて最近の音声コンテキストを再生する",
          startFreshAction: "新しく始める",
        },
        agentSource: {
          followSessionTitle: "セッションに追従",
          followSessionSubtitle:
            "セッションの backend と設定を使用します。",
          fixedAgentTitle: "固定エージェント",
          fixedAgentSubtitle:
            "常に特定のエージェント backend を使用します。",
        },
        permissionPolicy: {
          readOnlySubtitle:
            "コンテキストは参照できますが、ツールは実行できません。",
          noToolsSubtitle:
            "ツール要求を避け、ツールは実行しません。",
        },
        chatModelSource: {
          sessionSubtitle:
            "エージェントのチャットにセッションのモデル設定を使用します。",
          customSubtitle:
            "音声エージェントのチャットモデル ID を上書きします。",
        },
        chatModelId: {
          title: "音声エージェントのチャットモデルID",
          subtitle:
            "チャットモデルのソースを「カスタムモデル」にした場合に使用されます。",
        },
        commitModelSource: {
          chatSubtitle:
            "コミットにエージェントのチャットモデルを使用します。",
          sessionSubtitle:
            "コミットにセッションのモデル設定を使用します。",
          customSubtitle:
            "音声エージェントのコミットモデル ID を上書きします。",
        },
        commitModelId: {
          title: "音声エージェントのコミットモデルID",
          subtitle:
            "コミットモデルのソースを「カスタムモデル」にした場合に使用されます。",
        },
        commitIsolation: {
          title: "コミット分離",
          subtitle:
            "コミット生成に別のベンダーセッションを使用します（上級者向け）。",
        },
        resumability: {
          modeTitle: "再開",
          replayTitle: "リプレイ",
          replaySubtitle: "最近のメッセージを再生して再開します。",
          providerResumeTitle: "プロバイダ再開",
          providerResumeSubtitle:
            "プロバイダのセッション状態で再開します（対応時）。",
          disabledVoiceAgent: "Happier Voice Agent が必要です。",
          disabledDaemonBackend: "Daemon backend が必要です。",
          disabledAgentNoProviderResume:
            "選択したエージェントはプロバイダ再開に対応していません。",
        },
        providerResumeFallback: {
          title: "リプレイにフォールバック",
          subtitle:
            "プロバイダ再開が失敗したらリプレイに切り替えます。",
        },
        replayRecentMessagesPromptBody:
          "含める最近のメッセージ数（1–100）。",
        prewarm: {
          title: "接続時にプリウォーム",
          subtitle: "接続したらすぐに音声エージェントを起動します。",
        },
        welcome: {
          title: "ウェルカムメッセージ",
          offTitle: "オフ",
          offSubtitle: "ウェルカムメッセージを送信しません。",
          immediateTitle: "即時",
          immediateSubtitle:
            "エージェント開始直後にウェルカムを送信します。",
          onFirstTurnTitle: "初回発話時",
          onFirstTurnSubtitle:
            "最初に話したときにウェルカムを送信します。",
        },
        verbosity: {
          shortSubtitle: "エージェントの返答を短く保ちます。",
          balancedSubtitle: "必要なときは少し詳しくします。",
        },
        streaming: {
          title: "ストリーミング",
          enableTitle: "ストリーミングを有効化",
          enableSubtitle:
            "生成中にエージェントの部分テキストをストリーミングします（ストリーミング音声用）。",
          enableTtsTitle: "TTS ストリーミングを有効化",
          enableTtsSubtitle:
            "ストリーミング中に応答を読み上げます（ストリーミングが必要）。",
          ttsChunkCharsTitle: "TTS チャンク文字数",
          ttsChunkCharsPromptBody:
            "次の TTS チャンクを要求する前にバッファする文字数（32–2000）。",
        },
        network: {
          title: "ネットワーク",
          timeoutTitle: "ネットワークタイムアウト（ms）",
          timeoutPromptBody:
            "エンドポイントへのリクエストのタイムアウト（1000–60000）。",
        },
      },
      mediatorBackend: "メディエーター backend",
      mediatorBackendSubtitle:
        "Daemon（Happier の backend）または OpenAI 互換 HTTP",
      mediatorBackendDaemon: "デーモン",
      mediatorBackendOpenAi: "OpenAI 互換 HTTP",
      mediatorAgentSource: "メディエーター エージェントのソース",
      mediatorAgentSourceSubtitle:
        "セッションの backend を使うか、特定のエージェント backend を強制",
      mediatorAgentSourceSession: "セッションの backend",
      mediatorAgentSourceAgent: "特定のエージェント",
      mediatorAgentId: "メディエーター エージェント",
      mediatorAgentIdSubtitle:
        "メディエーターに使用するエージェント backend（セッションを使わない場合）",
      mediatorPermissionPolicy: "メディエーター権限",
      mediatorPermissionPolicySubtitle: "メディエーション中のツール利用を制限",
      mediatorPermissionReadOnly: "読み取り専用",
      mediatorPermissionNoTools: "ツールなし",
      mediatorVerbosity: "メディエーターの詳細さ",
      mediatorVerbositySubtitle: "メディエーターの返答の詳しさ",
      mediatorVerbosityShort: "短く",
      mediatorVerbosityBalanced: "バランス",
      mediatorIdleTtl: "メディエーター idle TTL",
      mediatorIdleTtlSubtitle: "非アクティブ時に自動停止（60–3600秒）",
      mediatorIdleTtlTitle: "メディエーター idle TTL（秒）",
      mediatorIdleTtlDescription: "60〜3600 の数値を入力してください。",
      mediatorIdleTtlInvalid: "60〜3600 の数値を入力してください。",
      mediatorChatModelSource: "メディエーター モデル（チャット）",
      mediatorChatModelSourceSubtitle:
        "セッションのモデル、またはカスタムの高速モデルを使用",
      mediatorChatModelSourceSession: "セッションのモデル",
      mediatorChatModelSourceCustom: "カスタムモデル",
      mediatorCommitModelSource: "メディエーター モデル（コミット）",
      mediatorCommitModelSourceSubtitle:
        "チャット/セッション/カスタムのいずれかのモデルを使用",
      mediatorCommitModelSourceChat: "チャットモデル",
      mediatorCommitModelSourceSession: "セッションのモデル",
      mediatorCommitModelSourceCustom: "カスタムモデル",
      chatBaseUrl: "チャット ベースURL",
      chatBaseUrlTitle: "チャット ベースURL",
      chatBaseUrlDescription:
        "OpenAI 互換 chat completion エンドポイントの Base URL（通常 /v1 で終わります）。",
      chatApiKey: "Chat APIキー",
      chatApiKeyTitle: "Chat APIキー",
      chatApiKeyDescription:
        "Chat サーバー用の任意 API キー（暗号化して保存）。空欄でクリアできます。",
      chatModel: "Chat モデル",
      chatModelSubtitle: "ライブ音声会話に使う高速モデル",
      chatModelTitle: "Chat モデル",
      chatModelDescription:
        "Chat サーバーに送信するモデル名（OpenAI 互換フィールド）。",
      modelCustomTitle: "カスタム…",
      modelCustomSubtitle: "モデル ID を入力",
      commitModel: "コミット モデル",
      commitModelSubtitle: "最終の指示メッセージ生成に使うモデル",
      commitModelTitle: "Commit モデル",
      commitModelDescription:
        "最終コミットメッセージ生成時に送信するモデル名。",
      chatTemperature: "チャット温度",
      chatTemperatureSubtitle: "ランダム性を調整（0–2）",
      chatTemperatureTitle: "チャット温度",
      chatTemperatureDescription: "0〜2 の数値を入力してください。",
      chatTemperatureInvalid: "0〜2 の数値を入力してください。",
      chatMaxTokens: "チャット最大トークン",
      chatMaxTokensSubtitle: "応答長を制限（空欄 = デフォルト）",
      chatMaxTokensTitle: "チャット最大トークン",
      chatMaxTokensDescription: "正の整数を入力するか、空欄でデフォルト。",
      chatMaxTokensPlaceholder: "空欄でデフォルト",
      chatMaxTokensUnlimited: "デフォルト",
      chatMaxTokensInvalid: "正の数を入力するか、空欄にしてください。",
      sttBaseUrl: "STT ベースURL",
      sttBaseUrlTitle: "STT ベースURL",
      sttBaseUrlDescription:
        "OpenAI 互換の文字起こしエンドポイントの Base URL（通常 /v1 で終わります）。",
      sttApiKey: "STT APIキー",
      sttApiKeyTitle: "STT APIキー",
      sttApiKeyDescription:
        "STT サーバー用の任意 API キー（暗号化して保存）。空欄でクリアできます。",
      sttModel: "STT モデル",
      sttModelSubtitle: "文字起こしリクエストで送信するモデル名",
      sttModelTitle: "STT モデル",
      sttModelDescription:
        "STT サーバーに送信するモデル名（OpenAI 互換フィールド）。",
      deviceStt: "デバイス STT（実験的）",
      deviceSttSubtitle:
        "OpenAI互換エンドポイントの代わりに端末内音声認識を使用",
      sttProvider: "STTプロバイダー",
      neuralStt: {
        title: "端末内 STT",
        webNotAvailableSubtitle:
          "Web では利用できません。デバイス、OpenAI互換、または Gemini STT を使用してください。",
      },
      ttsBaseUrl: "TTS ベースURL",
      ttsBaseUrlTitle: "TTS ベースURL",
      ttsBaseUrlDescription:
        "OpenAI 互換の音声エンドポイントの Base URL（通常 /v1 で終わります）。",
      ttsApiKey: "TTS APIキー",
      ttsApiKeyTitle: "TTS APIキー",
      ttsApiKeyDescription:
        "TTS サーバー用の任意 API キー（暗号化して保存）。空欄でクリアできます。",
      ttsModel: "TTS モデル",
      ttsModelSubtitle: "音声リクエストで送信するモデル名",
      ttsModelTitle: "TTS モデル",
      ttsModelDescription:
        "TTS サーバーに送信するモデル名（OpenAI 互換フィールド）。",
      ttsVoice: "TTS ボイス",
      ttsVoiceSubtitle: "音声リクエストで送信するボイス名/ID",
      ttsVoiceTitle: "TTS ボイス",
      ttsVoiceDescription:
        "TTS サーバーに送信するボイス名/ID（OpenAI 互換フィールド）。",
      ttsFormat: "TTS 形式",
      ttsFormatSubtitle: "TTS が返す音声形式",
      ttsFormatOptions: {
        mp3Subtitle: "出力が小さく、幅広く互換性があります。",
        wavSubtitle: "出力が大きく、非圧縮です。",
      },
      testTts: "TTSをテスト",
      testTtsSubtitle:
        "設定したローカルTTS（デバイスTTSまたはエンドポイント）で短いサンプルを再生",
      testTtsSample:
        "Happier からこんにちは。これはローカルTTSのテストです。",
      testTtsMissingBaseUrl: "先に TTS ベースURL を設定してください。",
      testTtsFailed:
        "TTSテストに失敗しました。ベースURL、APIキー、モデル、ボイスを確認してください。",
      deviceTts: "デバイス TTS（実験的）",
      deviceTtsSubtitle:
        "OpenAI互換エンドポイントの代わりに端末内音声合成を使用",
      ttsProvider: "TTSプロバイダー",
      ttsProviderSubtitle:
        "デバイスTTS、OpenAI互換エンドポイント、またはKokoro（Web/デスクトップ）を選択",

      autoSpeak: "返信を自動読み上げ",
      autoSpeakSubtitle:
        "音声メッセージ送信後、次のアシスタント返信を読み上げます",
      bargeIn: "バージイン",
      speaking: "発話中…",

      localNeuralTts: {
        provider: {
          title: "ローカルニューラル（ベータ）",
          subtitle: "Web では daemon によるニューラル TTS を使い、対応環境では端末内モデルパックも使えます。",
          detail: "ローカルニューラル",
        },
      },
      openaiCompatStt: {
        provider: {
          title: "OpenAI 互換エンドポイント",
          subtitle: "Whisper 互換の文字起こしサーバーを自分で使います。",
          detail: "エンドポイント",
        },
      },
      openaiCompatTts: {
        provider: {
          title: "OpenAI 互換エンドポイント",
          subtitle: "OpenAI 互換のローカルまたはリモート TTS サーバーを自分で使います。",
          detail: "エンドポイント",
        },
      },
      deviceSttDetail: "デバイス",
      deviceTtsDetail: "デバイス",
      daemonInference: {
        execution: {
          title: "ローカルニューラル実行",
          subtitle: "ローカルニューラル音声を端末内で実行するか daemon で実行するかを選択します。",
          options: { auto: "自動", device: "デバイス", daemon: "daemon 実行" },
          optionSubtitles: {
            auto: "このプラットフォームの推奨実行パスを優先します。",
            device: "対応している場合、このデバイス上でローカルニューラル音声を直接実行します。",
            daemon: "voice-home daemon 経由でローカルニューラル音声を実行します。",
          },
        },
        service: {
          title: "daemon 推論サービス",
          subtitle: "voice-home daemon 推論サービスの状態です。",
        },
        model: {
          title: "daemon モデルパック",
          subtitleTts: "daemon TTS モデルパックをインストールして更新します。",
          subtitleStt: "daemon STT モデルパックをインストールして更新します。",
        },
        remove: {
          title: "daemon モデルファイルを削除",
          subtitle: "このパックの daemon 側モデルファイルを削除します。",
          detailInstalled: "インストール済み daemon ファイルを削除",
        },
        states: {
          loading: "読み込み中…",
          machineUnreachable: "voice-home daemon を利用できません。",
          unavailable: "daemon 推論を利用できません。",
          runtimeUnavailable: "daemon runtime を利用できません。",
          relayDisabled: "daemon relay が無効です。",
          relayCapped: "daemon relay の容量上限に達しました。",
          requestTimeout: "daemon リクエストがタイムアウトしました。",
          warming: "モデルを準備中…",
          ready: "準備完了",
          degraded: "低下",
          idle: "待機中",
          installing: "インストール中…",
          installed: "インストール済み",
          installError: "インストールに失敗しました",
          notInstalled: "未インストール",
          latencyDemoted: "レイテンシが低下したため、この会話ではデバイス音声を使用します。",
          fallbackToDevice: "デバイス音声へフォールバックしています。",
        },
      },
      models: {
          title: "ローカル音声モデル",
          statusTitle: "モデルサービス",
          footer: "音声ホームのデーモンにローカル音声モデルパックをインストールし、種類ごとの既定を選択します。",
          sttGroupTitle: "音声認識モデル",
          ttsGroupTitle: "音声合成モデル",
          defaultBadge: "既定",
          defaultSubtitle: "この種類の既定",
          installSubtitle: "タップしてデーモンにインストール",
          setDefaultSubtitle: "タップして既定として使用",
          unknownSubtitle: "ステータスを取得できません",
          modelFiles: ({ size }: { size: string }) => `モデルファイル ${size}`,
          removeConfirmTitle: "モデルパックを削除",
          removeConfirmBody: ({ name }: { name: string }) => `のデーモン側ファイルを削除しますか ${name}?`,
          state: {
              notInstalled: "未インストール",
              downloading: "ダウンロード中…",
              installed: "インストール済み",
              warming: "ウォームアップ中…",
              ready: "準備完了",
              evicted: "アンロード済み",
              error: "インストール失敗",
              unknown: "ステータスを取得できません",
          },
      },
      machineErrors: {
        mic_permission_denied: "マイクの権限が拒否されました。",
        mic_ended: "マイク入力が終了しました。",
        mic_plateau: "マイク音声が止まりました。",
        transport_disconnect: "音声接続が切断されました。",
        provider_error: "音声プロバイダーでエラーが発生しました。",
        provider_auth_invalid: "選択した音声プロバイダーの API キーを追加または更新してください。",
        audio_context_suspended: "音声出力が一時停止されています。",
        stt_timeout: "聞き取り開始がタイムアウトしました。",
        tts_failed: "音声合成に失敗しました。",
        turn_aborted: "音声ターンが中止されました。",
        authentication_required: "音声を使用するには、選択したエージェントを接続してください。",
        session_unavailable: "選択したセッションは音声では利用できなくなりました。",
        unsupported_runtime: "音声を使用するには、選択したエージェントのランタイムをインストールしてください。",
        update_required: "音声を使用するには、選択したエージェントのランタイムを更新してください。",
        feature_unavailable: "選択したエージェントのランタイムでは音声を利用できません。",
      },},
    privacy: {
      title: "プライバシー",
      footer:
        "音声プロバイダーには選択されたセッションコンテキストが送信されます。",
      shareSessionSummary: "セッション要約を共有",
      shareSessionSummarySubtitle: "音声コンテキストにセッション要約を含めます",
      shareRecentMessages: "最近のメッセージを共有",
      shareRecentMessagesSubtitle:
        "音声コンテキストに最近のメッセージを含めます",
      recentMessagesCount: "最近のメッセージ数",
      recentMessagesCountSubtitle: "含める最近のメッセージ数（0–50）",
      recentMessagesCountTitle: "最近のメッセージ数",
      recentMessagesCountDescription: "0〜50 の数値を入力してください。",
      recentMessagesCountInvalid: "0〜50 の数値を入力してください。",
      shareToolNames: "ツール名を共有",
      shareToolNamesSubtitle: "音声コンテキストにツール名/説明を含めます",
      shareDeviceInventory: "デバイス情報を共有",
      shareDeviceInventorySubtitle:
        "音声が最近のワークスペース、マシン、サーバーを一覧できるようにします",
      shareToolArgs: "ツール引数を共有",
      shareToolArgsSubtitle: "ツール引数を含めます（パスや機密情報を含む場合があります）",
      sharePermissionRequests: "権限リクエストを共有",
      sharePermissionRequestsSubtitle: "権限プロンプトを音声に転送します",
      shareFilePaths: "ローカルのパスを共有",
      shareFilePathsSubtitle:
        "音声コンテキストにローカルパスを含めます（非推奨）",
    },
    languageTitle: "言語",
    languageDescription:
      "音声アシスタントの操作に使用する言語を選択します。この設定はすべてのデバイスで同期されます。",
    preferredLanguage: "優先言語",
    preferredLanguageSubtitle: "音声アシスタントの応答に使用する言語",
    language: {
      searchPlaceholder: "言語を検索...",
      title: "言語",
      footer: ({ count }: { count: number }) => `${count}言語が利用可能`,
      autoDetect: "自動検出",
      autoDetectSubtitle: "認識結果に任せます（推奨）",
      customTitle: "カスタム…",
      customSubtitle: "BCP-47 の言語タグを入力してください。",
      options: {
        english: "英語",
        englishUs: "英語（米国）",
        french: "フランス語",
        spanish: "スペイン語",
      },
    },
  },

  settingsAccount: {
    // Account settings screen
    accountInformation: "アカウント情報",
    status: "ステータス",
    statusActive: "アクティブ",
    statusNotAuthenticated: "未認証",
    anonymousId: "匿名ID",
    publicId: "公開ID",
    notAvailable: "利用不可",
    linkNewDevice: "QRをスキャンして新しいデバイスをリンク",
    linkNewDeviceSubtitle: "新しいデバイスに表示されたQRコードをスキャンします",
    profile: "プロフィール",
    name: "名前",
    github: "GitHub",
    showGitHubOnProfile: "プロフィールに表示",
    showProviderOnProfile: ({ provider }: { provider: string }) =>
      `プロフィールに${provider}を表示`,
    tapToDisconnect: "タップして切断",
    server: "サーバー",
    backup: "バックアップ",
    backupDescription:
      "シークレットキーはアカウントを復元する唯一の方法です。パスワードマネージャーなどの安全な場所に保存してください。",
    secretKey: "シークレットキー",
    tapToReveal: "タップして表示",
    tapToHide: "タップして非表示",
    secretKeyLabel: "シークレットキー (タップでコピー)",
    secretKeyCopied:
      "シークレットキーがクリップボードにコピーされました。安全な場所に保管してください！",
    secretKeyCopyFailed: "シークレットキーのコピーに失敗しました",
    privacy: "プライバシー",
    privacyDescription:
      "匿名の使用データを共有してアプリの改善にご協力ください。個人情報は収集されません。",
    analytics: "アナリティクス",
    analyticsDisabled: "データは共有されません",
    analyticsEnabled: "匿名の使用データが共有されます",
    crashReports: "クラッシュレポート",
    crashReportsDisabled: "クラッシュレポートは送信されません",
    crashReportsEnabled: "クラッシュレポートが共有されます",
    dangerZone: "危険ゾーン",
    logout: "ログアウト",
    logoutSubtitle: "サインアウトしてローカルデータを消去",
    logoutConfirm:
      "ログアウトしてもよろしいですか？シークレットキーのバックアップを取っていることを確認してください！",
    encryptionUpdateFailed: "暗号化設定の更新に失敗しました",
    secretKeyMissing: "秘密鍵を利用できません。先にアカウントを復元してください。",
    restoreRequiredTitle: "復元が必要です",
    restoreRequiredBody:
      "このアカウントには暗号化された履歴があります。このデバイスで暗号化を再度有効にするには、秘密鍵を復元してください。鍵を紛失した場合は、アカウントをリセットして新しく開始できます（以前の暗号化履歴は復元できません）。",
  },

  settingsLanguage: {
    // Language settings screen
    title: "言語",
    description:
      "アプリインターフェースの言語を選択します。この設定はすべてのデバイスで同期されます。",
    currentLanguage: "現在の言語",
    automatic: "自動",
    automaticSubtitle: "デバイス設定から検出",
    needsRestart: "言語が変更されました",
    needsRestartMessage:
      "新しい言語設定を適用するにはアプリの再起動が必要です。",
    restartNow: "今すぐ再起動",
  },

  connectButton: {
    authenticate: "ターミナルを認証",
    authenticateWithUrlPaste: "URLペーストでターミナルを認証",
    pasteAuthUrl: "ターミナルから認証URLを貼り付け",
  },

  updateBanner: {
    updateShort: "更新",
    updateAvailable: "アップデートが利用可能",
    pressToApply: "タップしてアップデートを適用",
    whatsNew: "新機能",
    seeLatest: "最新のアップデートと改善を確認",
    nativeUpdateAvailable: "アプリのアップデートが利用可能",
    tapToUpdateAppStore: "タップしてApp Storeで更新",
    tapToUpdatePlayStore: "タップしてPlay Storeで更新",

    checkNowTitle: "今すぐ確認",
    checkNowSubtitle: "利用可能なアプリのアップデートを確認します。",
    lastCheckedTitle: "最終確認",},

  changelog: {
    // Used by the changelog screen
    version: ({ version }: { version: string }) => `バージョン ${version}`,
    noEntriesAvailable: "変更履歴はありません。",
  },

  releaseNotes: {
    viewFullChangelog: "リリースノートをすべて表示",
    mediaUnavailable: "メディアを利用できません",
    storyDeck: {
      dragToDismiss: "ドラッグして閉じる",
      letsGo: "始めましょう！",
      slideAnnouncement: ({ title, current, total }: { title: string; current: number; total: number }) => `${title} - ${current} / ${total}`,
    },
    defaultTitle: "新着情報",
    onboardingShowcase: {
                "title": "Happierへようこそ",
                "subtitle": "あなたのAIエージェントを、働くすべての場所で。",
                "cards": {
                    "welcome": {
                        "title": "Happierへようこそ",
                        "everywhereTitle": "あなたのAIエージェントを、働くすべての場所で",
                        "everywhereBody": "Claude Code、Codex、OpenCode、Piなどを、スマートフォン、タブレット、ブラウザ、デスクトップで使えます。",
                        "cockpitTitle": "モバイル cockpit",
                        "cockpitBody": "チャット、ファイル、Git、エディタ、ターミナル。次のプロジェクトを作って出荷するために必要なものが、すべて手元にあります。",
                        "existingTitle": "既存のセッションも、そのまま表示",
                        "existingBody": "あなたのマシンで動いているClaude、Codex、OpenCodeのセッションを、Happierでライブに開けます。",
                        "voiceTitle": "一緒に考えられる音声アシスタント",
                        "voiceBody": "エージェントが何をしているかを聞き、権限リクエストを承認し、メッセージを送信できます。ハンズフリーで。",
                        "reviewTitle": "diffをレビューしてコメント",
                        "reviewBody": "ファイルやdiffの特定行をマークし、送るメモを選び、そのままエージェントに渡せます。",
                        "subagentsTitle": "プロバイダー横断のsubagents",
                        "subagentsBody": "ClaudeセッションからCodex subagentsを起動できます。作業をエージェント間で分担し、セッション間でメッセージをルーティングできます。",
                        "tuisTitle": "お気に入りのTUIをそのまま使う",
                        "tuisBody": "Claude Code、Codex、OpenCodeをネイティブなターミナルUIで実行できます。Happierがそれをキャプチャし、すべてのデバイスへ同期します。",
                        "inboxTitle": "1つのinbox。すべてのセッション。",
                        "inboxBody": "すべての保留中の承認、権限リクエスト、未読アクティビティを、すべてのセッションとマシンから1か所に集約します。",
                        "mcpTitle": "1つのMCP設定。すべてのプロバイダー。",
                        "mcpBody": "MCPサーバーは一度定義するだけ。MCPをネイティブ対応していないプロバイダーを含め、すべてのbackendで動作します。",
                        "controlTitle": "キュー、steer、fork、rollback",
                        "controlBody": "エージェントが忙しい間にメッセージをキューへ。実行中のturnをsteer。任意のメッセージからfork。必要なら元に戻せます。",
                        "automationsTitle": "自動化",
                        "automationsBody": "PRの監視、issueの確認、定期タスクの実行のために、エージェントセッションをスケジュールできます。",
                        "accountsTitle": "複数アカウントとクォータ追跡",
                        "accountsBody": "個人、仕事、チーム用など複数のClaudeまたはOpenAIアカウントを連携。各アカウントの使用量をアプリ内で確認できます。",
                        "promptsTitle": "Prompts、skills、profiles",
                        "promptsBody": "再利用できるprompts、skill bundles、backend profilesを、すべてのセッションとデバイスで同期します。",
                        "privacyTitle": "オープンソース。エンドツーエンド暗号化。セルフホスト可能。",
                        "privacyBody": "あなたのセッションはプライベートに保たれます。ソースは公開されています。1コマンドでセルフホストできます。",
                        "petsTitle": "Petsに会う",
                        "petsBody": "長いセッションのための小さな相棒。役に立つ？たぶん。魅力的？もちろん。"
                    ,
                        row1Title: "あらゆるデバイスでセッションを継続",
                        row1Body: "携帯、タブレット、ウェブ、デスクトップのどれでも続きから再開できます。",
                        row2Title: "速く動き、早く届ける",
                        row2Body: "リアルタイム同期がターミナル、エージェント、ファイルを揃えて保ちます。",
                        row3Title: "標準でプライベート",
                        row3Body: "エンドツーエンド暗号化により、作業はあなただけのものです。",},
                    "anywhere": {
                        "title": "どこでも始めて、どこでも続ける。",
                        "wideTitle": "どこでも始めて。\nどこでも続ける。",
                        "body": "どこからでもセッションを起動できます。スマートフォン、ブラウザ、デスクトップからライブで追跡し、メッセージを送り、権限を承認できます。",
                        "alt": "デバイス横断のエージェントセッション用の抽象的なプレースホルダー画像。"
                    },
                    "terminalTuis": {
                        "title": "ターミナルが好き？私たちもです！",
                        "wideTitle": "ターミナルが好き？\n私たちもです！",
                        "body": "Claude Code、Codex、OpenCodeをネイティブなターミナルUIで実行できます。スマートフォンから追跡し、メッセージを送り、権限を承認できます。",
                        "alt": "ターミナルTUI同期用の抽象的なプレースホルダー画像。"
                    },
                    "cockpit": {
                        "title": "必要なものを、ワンタップで。",
                        "wideTitle": "必要なものを。\nワンタップで",
                        "body": "チャット、ファイル、Git、エディタ、ターミナル。エージェントとやり取りし、ファイルを閲覧・編集し、diffをレビューし、Gitブランチを管理し、PRを開き、ライブターミナルを開けます。",
                        "alt": "モバイルcockpit用の抽象的なプレースホルダー画像。"
                    ,
                        row1Title: "Cockpit モード",
                        row1Body: "集中したモバイル表示で、動作中のエージェントを追えます。",
                        row2Title: "ワンタップで移動",
                        row2Body: "チャット、ファイル、Git、ターミナル、詳細をデスクトップ表示なしで切り替えられます。",
                        row3Title: "すばやく送信",
                        row3Body: "エージェントに一押しが必要なとき、cockpit から返信できます。",},
                    "existingSessions": {
                        "title": "既存のClaude、Codex、OpenCodeセッション？もうあります。",
                        "body": "実行中かどうかに関係なく、Claude、Codex、OpenCodeのセッションを参照できます。",
                        "alt": "既存プロバイダーセッション用の抽象的なプレースホルダー画像。"
                    },
                    "voiceAssistant": {
                        "title": "話しかけられる同僚",
                        "wideTitle": "音声アシスタント：話しかけられる同僚",
                        "body": "音声アシスタントが実行中のすべてのセッションを監視します。次の変更を一緒に考え、権限を承認し、さらに多くのことをハンズフリーで行えます。",
                        "alt": "音声アシスタント用の抽象的なプレースホルダー画像。"
                    },
                    "reviewComments": {
                        "title": "コードをレビューしてコメントを残す",
                        "body": "エージェントの変更とdiffを確認できます。対応したい正確な行をマークし、現在のセッションまたは新しいセッションのエージェントへ送信できます。",
                        "alt": "レビューコメント用の抽象的なプレースホルダー画像。"
                    ,
                        row1Title: "正確な行にコメント",
                        row1Body: "ファイルや diff の行へ直接フィードバックを残せます。",
                        row2Title: "送る内容を選択",
                        row2Body: "エージェントに頼む前に、コメントを確認、編集、除外、追加できます。",
                        row3Title: "文脈を添えて送信",
                        row3Body: "構造化されたレビュー文脈を現在のセッションまたは新しいセッションへ送れます。",},
                    "subagents": {
                        "title": "1つのセッションで、マルチプロバイダーsubagents",
                        "body": "任意のセッションでCodex、Claude、その他のsubagentsを開始できます。それぞれの強みを活かし、同じセッション内で一緒に作業させられます。",
                        "alt": "プロバイダー横断subagents用の抽象的なプレースホルダー画像。"
                    },
                    "inbox": {
                        "title": "もう流れを見失わない",
                        "body": "10個のセッションを同時に動かして、何に注意すべきか見失っていませんか？Inboxが、すべてのセッションとマシンのアクティビティを表示します。",
                        "alt": "グローバルinbox用の抽象的なプレースホルダー画像。"
                    },
                    "mcp": {
                        "title": "1つの設定。すべてのプロバイダー。",
                        "wideTitle": "1つの設定。\nすべてのプロバイダー。",
                        "body": "HappierでMCPを一度定義すれば、MCPをネイティブ対応していないものを含むすべてのbackendで動作します。Skills、promptsなどを管理できます！",
                        "alt": "共有MCP設定用の抽象的なプレースホルダー画像。"
                    },
                    "queue": {
                        "title": "キュー、steer、fork、rollback",
                        "body": "エージェントが忙しい間にメッセージをキューに入れられます。実行中のセッションをsteerできます。任意のメッセージからforkできます。うまくいかなければrollbackできます。",
                        "alt": "セッション制御ツール用の抽象的なプレースホルダー画像。"
                    },
                    "automations": {
                        "title": "エージェントをスケジュールで",
                        "body": "Pull requestの監視、issueの確認、定期タスクの実行のために、繰り返しセッションをスケジュールできます。",
                        "alt": "スケジュールされたエージェント自動化用の抽象的なプレースホルダー画像。"
                    },
                    "accounts": {
                        "title": "複数アカウントとクォータ追跡",
                        "body": "複数のOpenAIまたはClaudeアカウントを連携できます。各アカウントの使用量とクォータをアプリ内で確認できます。",
                        "alt": "連携アカウントとクォータ用の抽象的なプレースホルダー画像。"
                    },
                    "privacy": {
                        "title": "オープンソース。エンドツーエンド暗号化。",
                        "wideTitle": "オープンソース。\nエンドツーエンド暗号化。",
                        "body": "コード、prompts、セッション内容は、サーバーに届く前にあなたのデバイス上で暗号化されます。Private by design. Open by default.",
                        "alt": "プライバシーとセルフホスト用の抽象的なプレースホルダー画像。"
                    },
                    "pets": {
                        "title": "一人で作業しなくていい。Petsに会おう。",
                        "wideTitle": "一人で作業しなくていい。\nPetsに会おう。",
                        "body": "セッションをまたいで集中を保つのを助ける小さな相棒。役に立つ？たぶん。魅力的？もちろん。",
                        "alt": "Pets用の抽象的なプレースホルダー画像。"
                    ,
                        row1Title: "小さな相棒",
                        row1Body: "セッションをまたいで集中を保つ手助けをします。",
                        row2Title: "活動を追跡",
                        row2Body: "デスクトップとモバイルでセッション活動を表示します。",
                        row3Title: "便利？たぶん。",
                        row3Body: "魅力的？間違いなく。",}
                ,
                    sourceControl: {
            title: "作って、そのまま出荷",
            body: "Happier を離れずに、ブランチの作成と公開、リモート管理、変更ファイルの確認、pull request 作成ができます。",
            alt: "ソース管理用の抽象プレースホルダー画像。",
            row1Title: "ブランチと公開",
            row1Body: "Happier を離れずにブランチ作成、リモート管理、push ができます。",
            row2Title: "Pull request を開く",
            row2Body: "既存 PR を再利用するか、セッションから新しい PR を作成できます。",
            row3Title: "変更ファイルを確認",
            row3Body: "大きな変更でも、選んだファイルに集中できます。",
        },
                    markdown: {
            title: "より滑らかなストリーミング、より豊かな Markdown",
            body: "ストリーミング応答はより滑らかに感じられ、豊かな Markdown で長い回答、コード、リスト、図が読みやすくなります。",
            alt: "Markdown 表示用の抽象プレースホルダー画像。",
            row1Title: "出力が追いつく",
            row1Body: "エージェントが書いている間のストリーミング応答がより滑らかに感じられます。",
            row2Title: "Markdown が強化",
            row2Body: "コードフェンス、リスト、表、長い回答をより確実に表示します。",
            row3Title: "圧縮がわかりやすく",
            row3Body: "トランスクリプト内のライフサイクルイベントを追いやすくなりました。",
        },
                    media: {
            title: "画像もトランスクリプト内で",
            body: "Codex と対応エージェントに画像生成を依頼し、結果を Happier 内で直接プレビューできます。",
            alt: "生成メディア用の抽象プレースホルダー画像。",
            row1Title: "画像を生成",
            row1Body: "Codex と対応エージェントに画像生成を依頼できます。",
            row2Title: "インラインでプレビュー",
            row2Body: "生成画像は Happier の会話内に直接表示されます。",
            row3Title: "セッションと一緒に保存",
            row3Body: "メディアも作業と同じセッションパイプラインを通ります。",
        },
                    desktop: {
            title: "より磨かれたデスクトップアプリ",
            body: "よりクリーンなデスクトップシェル。磨かれた chrome、安全な余白、適切な場所の更新ステータスを備えています。",
            alt: "デスクトップアプリ用の抽象プレースホルダー画像。",
            row1Title: "よりクリーンな Chrome",
            row1Body: "サイドバー操作と更新ステータスがより自然に収まります。",
            row2Title: "集中しやすく",
            row2Body: "ウィンドウとセッション面が作業の邪魔をしにくくなりました。",
            row3Title: "安全なレイアウト",
            row3Body: "プラットフォーム chrome とノッチ付き画面の余白をより適切に扱います。",
        },}
            },
  },

  terminal: {
    // Used by terminal connection screens
    webBrowserRequired: "Webブラウザが必要です",
    webBrowserRequiredDescription:
      "ターミナル接続リンクはセキュリティ上の理由からWebブラウザでのみ開くことができます。QRコードスキャナーを使用するか、コンピューターでこのリンクを開いてください。",
    processingConnection: "接続を処理中...",
    invalidConnectionLink: "無効な接続リンク",
    invalidConnectionLinkDescription:
      "接続リンクが見つからないか無効です。URLを確認して再試行してください。",
    connectTerminal: "ターミナルを接続",
    terminalRequestDescription:
      "ターミナルがHappier Coderアカウントへの接続を要求しています。これにより、ターミナルは安全にメッセージを送受信できるようになります。",
    connectionDetails: "接続の詳細",
    publicKey: "公開鍵",
    encryption: "暗号化",
    endToEndEncrypted: "エンドツーエンド暗号化",
    acceptConnection: "接続を承認",
    connecting: "接続中...",
    reject: "拒否",
    security: "セキュリティ",
    securityFooter:
      "この接続リンクはブラウザ内で安全に処理され、サーバーには送信されませんでした。あなたのプライベートデータは安全に保たれ、メッセージを復号できるのはあなただけです。",
    securityFooterDevice:
      "この接続はデバイス上で安全に処理され、サーバーには送信されませんでした。あなたのプライベートデータは安全に保たれ、メッセージを復号できるのはあなただけです。",
    clientSideProcessing: "クライアントサイド処理",
    linkProcessedLocally: "リンクはブラウザ内でローカルに処理されました",
    linkProcessedOnDevice: "リンクはデバイス上でローカルに処理されました",
    switchServerToConnectTerminal: ({ serverUrl }: { serverUrl: string }) =>
      `This connection is for ${serverUrl}. Switch servers and continue?`,
  },

  terminalEmbedded: {
    dockMenuA11y: "ターミナルをドック",
    largePasteTitle: "大きなターミナル入力を貼り付けますか？",
    largePasteDescription: "この貼り付け内容は大きく、ターミナルでコマンドを実行する可能性があります。続行する前に確認してください。",
    largePasteConfirm: "ターミナルに貼り付け",
    settings: {
      locationTitle: "埋め込みターミナルの場所",
      rendererTitle: "ターミナルレンダラー",
      rendererAuto: "自動",
      rendererAutoDescription: "ネイティブレンダラーが完全に利用可能な場合を除き、アクセシビリティ対応の xterm.js レンダラーを使います。",
      rendererXtermWebView: "xterm.js WebView",
      rendererXtermWebViewDescription: "アクセシビリティ対応が最も安定した互換レンダラーです。",
      rendererNativeExperimental: "ネイティブ（実験的）",
      rendererNativeExperimentalDescription: "すべてのネイティブゲートを満たした場合に、iOS では Ghostty、Android では Termux を優先します。",
    },
    quickKeys: {
      esc: "ESC",
      tab: "TAB",
      ctrlC: "Ctrl + C",
      ctrlD: "Ctrl + D",
      enter: "改行",
    },
    location: {
      sidebar: "サイドバー",
      details: "詳細パネル",
      bottom: "下部パネル",
    },
    errors: {
      missingMachineTarget: "このセッションにはマシンターゲットがありません。",
      rpcTargetUnavailable: "このマシンでは Machine RPC が利用できません。",
      machineUnreachable: "マシンに到達できません。",
      disabled: "デーモン設定でターミナル機能が無効になっています。有効にしてデーモンを再起動してください。",
      notFound: "ターミナルセッションが見つかりません。再起動してみてください。",
      cwdDenied: "デーモンにはこの作業ディレクトリを使用する権限がありません。",
      spawnFailed: "ターミナルプロセスの起動に失敗しました。",
      invalidRequest: "無効なターミナルリクエストです。",
      busy: "ターミナルが使用中です。もう一度お試しください。",
    },

    openNewTabA11y: "新しいターミナルタブを開く",},

  modals: {
    // Used across connect flows and settings
    authenticateTerminal: "ターミナルを認証",
    pasteUrlFromTerminal: "ターミナルから認証URLを貼り付けてください",
    deviceLinkedSuccessfully: "デバイスが正常にリンクされました",
    terminalConnectedSuccessfully: "ターミナルが正常に接続されました",
    terminalAlreadyConnected: "接続は既に使用されています",
    terminalConnectionAlreadyUsedDescription: "この接続リンクは既に別のデバイスで使用されています。複数のデバイスを同じターミナルに接続するには、すべてのデバイスでログアウトし、同じアカウントにログインしてください。",
    authRequestExpired: "接続の有効期限が切れています",
    authRequestExpiredDescription: "この接続リンクの有効期限が切れています。ターミナルから新しいリンクを生成してください。",
    pleaseSignInFirst: "Please sign in (or create an account) first.",
    invalidAuthUrl: "無効な認証URL",
    microphoneAccessRequiredTitle: "マイクへのアクセスが必要です",
    microphoneAccessRequiredRequestPermission:
      "Happier は音声チャットのためにマイクへのアクセスが必要です。求められたら許可してください。",
    microphoneAccessRequiredEnableInSettings:
      "Happier は音声チャットのためにマイクへのアクセスが必要です。端末の設定でマイクのアクセスを有効にしてください。",
    microphoneAccessRequiredBrowserInstructions:
      "ブラウザの設定でマイクへのアクセスを許可してください。アドレスバーの鍵アイコンをクリックし、このサイトのマイク権限を有効にする必要がある場合があります。",
    openSettings: "設定を開く",
    developerMode: "開発者モード",
    developerModeEnabled: "開発者モードが有効になりました",
    developerModeDisabled: "開発者モードが無効になりました",
    disconnectGithub: "GitHubを切断",
    disconnectGithubConfirm:
      "切断すると、再連携するまで「友達」と友達共有が無効になります。",
    disconnectService: ({ service }: { service: string }) => `${service}を切断`,
    disconnectServiceConfirm: ({ service }: { service: string }) =>
      `${service}をアカウントから切断してもよろしいですか？`,
    disconnect: "切断",
    failedToConnectTerminal: "ターミナルの接続に失敗しました",
    cameraPermissionsRequiredToConnectTerminal:
      "ターミナルの接続にはカメラの権限が必要です",
    failedToLinkDevice: "デバイスのリンクに失敗しました",
    cameraPermissionsRequiredToScanQr:
      "QRコードのスキャンにはカメラの権限が必要です",
    qrScannerUnavailable:
      "QRスキャナーを開けませんでした。もう一度試すか、URLを手動で入力してください。",
  },

  navigation: {
    // Navigation titles and screen headers
    connectTerminal: "ターミナルを接続",
    linkNewDevice: "新しいデバイスをリンク",
    restoreWithSecretKey: "シークレットキーで復元",
    whatsNew: "新機能",
    friends: "友達",
    automations: "自動化",
    automation: "自動化",
    newAutomation: "新しい自動化",
    sourceControl: "バージョン管理",
    developerTools: "開発者ツール",
    listComponentsDemo: "リストコンポーネントデモ",
    typography: "タイポグラフィ",
    colors: "カラー",
    toolViewsDemo: "ツールビューのデモ",
    maskedProgress: "マスク付き進捗",
    shimmerViewDemo: "シマー表示デモ",
    multiTextInput: "マルチテキスト入力",
    connectClaude: "Claude に接続",
    zenNewTask: "新しいタスク",
    zenTaskDetails: "タスク詳細",
  },

  welcome: {
    // Main welcome screen for unauthenticated users
    title: "CodexとClaude Codeのモバイルクライアント",
    subtitle:
      "デフォルトでエンドツーエンド暗号化され、他のデバイスでもアカウントを復元できます。",
    createAccount: "アカウントを作成",
    chooseEncryptionTitle: "暗号化を選択",
    chooseEncryptionBody: "このサーバーは暗号化あり／なしのアカウントに対応しています。アカウントデータの保存方法を選択してください。",
    chooseEncryptionEncrypted: "エンドツーエンド暗号化で続行",
    chooseEncryptionPlain: "暗号化なしで続行",
    signUpWithProvider: ({ provider }: { provider: string }) =>
      `${provider}で続行`,
    signInWithCertificate: "証明書でサインイン",
    linkOrRestoreAccount: "アカウントをリンクまたは復元",
    loginWithMobileApp: "モバイルアプリでログイン",
    serverUnavailableTitle: "Relay に接続できません",
    serverUnavailableBody: ({ serverUrl }: { serverUrl: string }) =>
      `${serverUrl} に接続できません。再試行するか、別の Relay を選んで続行してください。`,
    serverIncompatibleTitle: "Relay が未対応です",
    serverIncompatibleBody: ({ serverUrl }: { serverUrl: string }) =>
      `${serverUrl} の Relay から想定外の応答が返されました。その Relay を更新するか、別の Relay を選んで続行してください。`,

    // Unified onboarding redesign — BrandPanel (left pane / mobile hero)
    brandTaglineLine1: "どこからでも始められる。",
    brandTaglineLine2: "どこででも続けられる。",
    brandSubTagline: "あらゆるコーディングエージェントのためのコントロールルーム — お使いのすべてのデバイスで。",
    brandTrustStrip: "エンドツーエンド暗号化 · オープンソース · セルフホスト可能",
    providerMarkRowAccessibilityLabel: "対応している AI コーディングエージェント",

    // Unified onboarding redesign — welcome decision (right pane)
    welcomeQuestionTitle: "ようこそ。",
    welcomeQuestionSubtitle: "初めてですか?",
    welcomeQuestionBody: "Happier は AI コーディングエージェントのコントロールルームです。メールアドレスは不要。アカウントはこのデバイスで生成される秘密鍵です。",

    welcomePrimaryButton: "初めてですか — はじめましょう",
    welcomePrimarySubtitle: "ワンタップ。フォーム不要。鍵はこの端末に保管されます。",

    welcomeSecondaryButton: "ログイン — すでに Happier を使っています",
    welcomeSecondarySubtitle: "QRコードをスキャンするか、シークレットキーを入力してください",

    // Unified onboarding redesign — returning-user copy variants.
    // Shown when localSettings.hasCompletedAuthOnce === true, i.e. the
    // user has already created an account or signed in at least once on
    // this device. A returning user gets a warmer, more personal welcome
    // than "First time here?".
    //
    // useReturningGreeting() picks ONE title and ONE subtitle from these
    // pools at random — per-mount, locked via useRef so it doesn't change
    // mid-render. Titles and subtitles are picked independently, so any
    // (4 × 3) = 12 combinations are possible. The intent is to make the
    // returning experience feel alive rather than canned.
    //
    // The title pool is "welcome"-style (greeting). Aim: fits on one
    // line at 44px on a ~370px wide pane. The subtitle pool is
    // "let's go"-style (inviting question or call-to-action). Aim: fits
    // on one or two lines at 44px.
    welcomeReturningTitle1: "また会えましたね。",
    welcomeReturningTitle2: "お会いできて嬉しいです。",
    welcomeReturningTitle3: "来てくれてありがとう。",
    welcomeReturningTitle4: "おかえりなさい。",
    welcomeReturningSubtitle1: "続きから始めましょう。",
    welcomeReturningSubtitle2: "さあ、始めますか?",
    welcomeReturningSubtitle3: "今日は何を作りましょう?",

    // Returning-user buttons. For returning users we invert the visual
    // hierarchy: Login becomes the filled primary action (probability of
    // intent is high), Start fresh becomes the bordered secondary action.
    // "I already use Happier" is dropped from the login button title for
    // returning users because — they obviously do already use Happier.
    welcomeReturningLoginButton: "ログイン — 続きから始めましょう",
    welcomeReturningStartFreshButton: "新しく始める — 新しいアカウントを作成",
    welcomeReturningStartFreshSubtitle: "この端末で新しい鍵を生成します。",

    // Welcome step footer links
    welcomeFooterRelay: "セルフホスティング?",
    welcomeFooterRelayAction: "自分の Relay を使う",
    // Shown in place of welcomeFooterRelay when the active server is a
    // custom (non-Happier-Cloud) relay. The action below the label is the
    // relay's host (optionally with :port) followed by a small pencil
    // icon so the user can tap to edit. Long hostnames are truncated with
    // a tail-ellipsis to avoid colliding with the right-side Docs group.
    welcomeFooterRelayActiveLabel: "使用中の Relay:",
    welcomeFooterRelayEditAccessibility: "Relay を変更",
    welcomeFooterDocs: "ヘルプが必要ですか?",
    welcomeFooterDocsAction: "ドキュメント",
    welcomeFooterGithubLabel: "GitHub リポジトリ",
    welcomeFooterDiscordLabel: "Discord コミュニティ",

    // Mobile brand hero CTA
    brandHeroGetStarted: "はじめる",
  },

      sessionGettingStarted: {

          title: {

              connectMachine: 'このコンピューターをセットアップ',

              startDaemon: 'このコンピューターを再接続',

              createSession: 'セッションを作成',

              selectSession: 'セッションを選択',

              loading: '読み込み中…',

          },
        cliFollowUpTitle: 'ターミナルでの代替手順（任意）',
        manualDisclosure: {
            show: '手動のターミナル手順を表示',
            hide: '手動のターミナル手順を非表示',
        },

          subtitle: {

              connectMachine: ({ targetLabel }: { targetLabel: string }) =>

                  `デスクトップのセットアップフローを使って、このコンピューターを ${targetLabel} に接続します。ターミナル経由を使いたい場合のみ、手動手順を開いてください。`,

              startDaemon: ({ targetLabel }: { targetLabel: string }) =>

                  `デスクトップのセットアップフローを使って、${targetLabel} のバックグラウンドサービスを再接続します。すでにそのコンピューターにいる場合のみ、手動手順を開いてください。`,

              createSession: '+ ボタン、またはターミナルから新しいセッションを開始します。',

              selectSession: 'サイドバーからセッションを選ぶとここに表示されます。',

              loading: 'マシンとセッションを取得しています…',

          },

          steps: {

              openSetup: {

                  title: 'デスクトップのセットアップフローを使う',

                  description: 'これが推奨手順です。Relay を設定し、バックグラウンドサービスをインストールし、残りのセットアップもアプリ内で完了できます。',

              },

              startDaemonOpenSetup: {

                  description: 'ターミナルのコマンドに切り替える前に、デスクトップのセットアップフローでこのコンピューターのバックグラウンドサービスを再接続または修復します。',

              },

              installCli: {

                  title: 'CLI をインストール',

                  description: '接続したいマシンで一度だけ実行してください。',

                  copyLabel: 'インストールコマンド',

              },

              serverSetup: {

                  title: 'アクティブな Relay を設定',

                  description: '次のコマンドが正しい Relay を対象にするための一度きりの設定です。',

                  copyLabel: 'Relay 設定',

              },

              authLogin: {

                  title: 'サインイン',

                  description: 'ターミナルをアカウントに接続するための QR / リンクを表示します。',

                  copyLabel: '認証ログイン',

              },

              daemonInstall: {

                  title: 'バックグラウンドサービスをインストール（推奨）',

                  description: 'Happier をバックグラウンドで待機させ、リモート起動できるようにします。',

                  copyLabel: 'デーモンのインストール',

              },

              startDaemonInstall: {

                  description: '常駐するユーザーサービスをインストールして開始します。',

              },

              daemonStart: {

                  title: 'バックグラウンドサービスを一度開始',

                  description: '今すぐ動かしたいだけならこれを使います。',

                  copyLabel: 'デーモンの開始',

              },

              createSession: {

                  title: 'セッションを作成',

                  description: 'アプリの + ボタンか、ターミナルからこれらのいずれかを実行します。',

                  copyLabel: 'セッション作成',

              },

              startSession: {

                  title: 'コンピューターからセッションを開始',

                  description: 'またはアプリの + ボタンを使います。',

                  copyLabel: 'セッション開始',

              },

          },

      },


  setupOnboarding: {
		          screenTitle: 'このコンピューターをセットアップ',
		          welcomeTitle: 'Happierへようこそ',
			          welcomeBody: 'Happier は Relay を通じてスマホとコンピューターをつなぎ、セッションをどこでも続けられるようにします。',
			          welcomeBody2: 'オープンソース。エンドツーエンド暗号化。ゼロ知識。',
			          welcomeBody3: '開発者による、開発者のための。',
			          providersShowcaseLabel: '対応プロバイダー:',
	          letsStart: '始める',
	          scanQrCode: 'QRコードをスキャン',
          recommendedBadge: 'おすすめ',
	          relayCloudTitle: 'Happier Cloud',
	          relayCloudSubtitle: '最も簡単に始められるホスト型Relay',
	          relayOnThisComputerTitle: 'このコンピューターで',
	          relayOnThisComputerSubtitle: 'このコンピューターでRelayをローカルに実行し、スマホアクセス用にTailscaleを追加します',
	          relayOnYourComputerTitle: 'あなたのコンピューターで',
	          relayOnYourComputerSubtitle: 'あなたのコンピューターでRelayをローカルに実行し、スマホアクセス用にTailscaleを追加します',
	          relayOnRemoteComputerTitle: 'リモートのコンピューターでRelayをセットアップ',
	          relayOnRemoteComputerSubtitle: 'SSH でリモートのコンピューターに Relay をホストします',
	          remoteRelayHostInstallTitle: 'リモートのコンピューターで Relay をホスト',
	          relayAccessWizardTitle: '電話からこのRelayにどうアクセスしますか？',
	          relayAccessUrlTitle: 'リレー URL',
	          relayAccessUrlSubtitle: 'スマホからアクセスできる URL を入力してください。',
	          relayAccessUrlBody: 'LAN アドレス、カスタムドメイン、トンネル URL など、スマホから開ける URL を入力してください。',
	          relayAccessCloudflareTitle: 'Cloudflare トンネル',
	          relayAccessCloudflareSubtitle: 'Cloudflare の Named Tunnel を使って Relay を公開します。',
	          relayAccessCloudflareBody: 'Named Tunnel を作成または選択すると、ローカル Relay へ転送するように設定します。',
          changeRelay: 'Relay を変更',
          relayCustomUrlTitle: '既存の Relay',
          relayCustomUrlSubtitle: 'すでに動かしているRelayのURLを使います',
          authRestoreTitle: 'このデバイスを復元または追加',
          authRestoreSubtitle: 'QRコードかリンクを使ってこのデバイスを接続します',
          authSecretKeyTitle: '秘密鍵でログイン',
          authSecretKeySubtitle: '秘密鍵を入力してHappierにサインインします',
          authLostAccessTitle: 'アクセスを失いましたか？',
          authLostAccessSubtitle: 'IDプロバイダでアカウントをリセットします',
          webRelayHostHandoffTitle: 'このコンピュータでRelayを設定',
          webRelayHostHandoffBody: 'このコンピュータでRelayをホストするには、デスクトップアプリまたはCLIを使用します。案内に従って進め、表示されたRelay URLをここに貼り付けて続行してください。',
          webDesktopOnlyTitle: 'デスクトップアプリが必要です',
          webDesktopOnlyBody: 'このコンピューターをセットアップするにはデスクトップアプリを開いてください。Webアプリは状態を表示できますが、バックグラウンドサービスのインストールや設定はできません。',
          webDesktopOnlyPrimary: 'Relay URL を持っています',
          webDesktopOnlyDesktopAppTitle: 'デスクトップアプリでこの設定を続行',
          webDesktopOnlyDesktopAppSubtitle: 'Happier をダウンロードして開き、このコンピューターをガイド付きでセットアップします。',
          webDesktopOnlyDesktopAppButton: 'デスクトップアプリをダウンロード',
          webDesktopOnlyCliTitle: 'このコンピューターに CLI をインストール',
          webDesktopOnlyCliSubtitle: 'ターミナルで一度だけ実行します（Node は不要）。',
          handoffPlatformPosixLabel: 'macOS/Linux',
          handoffPlatformMacosLabel: 'macOS',
          handoffPlatformLinuxLabel: 'Linux',
          handoffPlatformWindowsLabel: 'Windows',
          orDividerLabel: 'または',
          webDesktopOnlySetupCommandTitle: 'CLI でこのコンピューターをセットアップ',
          webDesktopOnlySetupCommandSubtitle: '1つのコマンドで Relay を設定し、必要ならサインインし、バックグラウンドサービスをインストールします。',
          webDesktopOnlySetupRemotePrereqsSubtitle: 'SSH でリモートコンピューターをセットアップする前に、1つのコマンドで Relay 設定とサインインを行います。',
          webDesktopHandoffDesktopAppOption: 'デスクトップアプリを使う（推奨）',
          webDesktopHandoffDesktopAppSubtitle: 'Happier をダウンロードして開き、ガイド付きで Relay をホストします。',
          webDesktopHandoffCliOption: 'ターミナル（CLI）を使う',
          webDesktopHandoffCliSubtitle: 'いくつかのコマンドで Relay をホストし、表示された Relay URL をここに貼り付けます。',
          webDesktopOnlyRelayInstallTitle: 'このコンピューターで Relay をホスト',
	          webDesktopOnlyRelayInstallSubtitle: 'Relay ホストをインストールして起動します。表示された Relay URL をここに貼り付けてください。',
	          webDesktopOnlyRelayStatusTitle: 'Relay の URL を取得',
	          webDesktopOnlyRelayStatusSubtitle: 'このコマンドで Relay の URL を表示し、ここに貼り付けてください。',
	          webDesktopOnlyOptionalNextTitle: '任意: セキュアアクセスとプロバイダー',
	          webDesktopOnlyOptionalNextBody: 'Happier をインストールしたら、設定 → セキュアアクセス (Tailscale) でスマホを接続し、設定 → プロバイダーで利用したいツールをインストールできます。',
			          preAuthTitle: 'Relay はどこにありますか？',
	          preAuthBody: 'Relay はスマホとコンピュータの間でメッセージを中継します。Relay をどこで動かすか選んでください。後から変更できます。',
          preAuthContinueHint: '続行すると、選択した Relay でサインインする画面に戻り、その後この画面に戻ってセットアップを完了します。',
		    currentRelayTitle: '現在のサーバー',
		    selectedRelayFooterLabel: '現在のサーバー',
		    selectedRelayFooterLine: ({ relay }: { relay: string }) => `現在のサーバー：${relay}`,
		    currentRelayDescription: ({ relayUrl }: { relayUrl: string }) => `現在の Relay：${relayUrl}`,
		    accountWillLiveOnRelay: ({ relayUrl }: { relayUrl: string }) => `アカウントは ${relayUrl} に保存されます。`,
		    savedRelaysTitle: '保存済みの Relay',
            removeRelayConfirmTitle: 'Relay を削除しますか？',
            removeRelayConfirmBody: 'このデバイスの保存済み Relay から削除します。',
	    customRelayUrlLabel: 'Relay の URL',
    relayNameLabel: 'Relay 名',
    addAndUseRelay: 'Relay を追加',
    changeRelayAction: '別の Relay URL を使う',
          continueToAuth: '選択した Relay で続行',
          continueWithLocalRelayAction: 'このローカル Relay で続行',
    postAuthTitle: 'このコンピューターの設定を完了',
    postAuthBody: 'サインインしました。ローカルのセットアップフローを続けて、このコンピューターを選択した Relay で使えるようにします。',
    setupThisComputerTitle: 'このコンピューターをセットアップ',
    controlPanelTitle: '準備状況の概要',
    activeRelaySummaryTitle: 'アクティブな Relay',
    thisComputerSummaryTitle: 'このコンピューター',
    nextActionSummaryTitle: '次のアクション',
    thisComputerReady: 'この Relay で準備完了',
    nextActionReady: '最初のセッションを作るか、下に別のコンピューターを追加してください。',
    thisComputerStages: {
        installToolsTitle: 'Happierツールをインストール',
        installToolsSubtitle: 'このコンピューターのセットアップに必要なローカルのHappierコマンドラインツールをインストールします。',
        installToolsReadySubtitle: 'ローカルのHappierツールはこのコンピューターですでに利用できます。',
        installToolsDetails: 'ローカルセットアップで使う管理対象のHappierランタイムが利用可能であることを確認し、このリリースチャネルに対応するターミナルコマンドを同期します。',
        installToolsChildTitle: 'ローカルのHappierコマンドラインツールをインストール',
        useRelayTitle: 'このRelayを使用',
        useRelayAccountMismatchSubtitle: '続行する前に、このサーバーに対応するアカウントに切り替えてください。',
        useRelayNeedsAuthSubtitle: 'このサーバーのセットアップを続けるには、サインインするかアカウントを作成してください。',
        useRelaySignedInSubtitle: '現在のアカウントはすでにサインイン済みで、このサーバーを利用する準備ができています。',
        useRelayServerMismatchSubtitle: ({ activeRelayUrl, daemonRelayUrl }: { activeRelayUrl: string; daemonRelayUrl: string }) =>
            `アプリサーバー: ${activeRelayUrl}. バックグラウンドサービス: ${daemonRelayUrl}.`,
        useRelayConnectedSubtitle: ({ relayUrl }: { relayUrl: string }) => `${relayUrl} に接続済みです。`,
        useRelayMissingSubtitle: '続行するにはサーバーを選択または追加してください。',
        useRelayDetails: 'ローカル登録を開始する前に、このコンピューターが使用するRelayとアカウントを確認します。',
        backgroundServiceTitle: 'バックグラウンドサービス',
        backgroundServiceDecisionSubtitle: 'このコンピューターが既定のバックグラウンドサービスをどのように所有するかを選択してください。',
        backgroundServiceRunningSubtitle: 'バックグラウンドサービスはインストール済みで実行中です。',
        backgroundServiceInstalledSubtitle: 'バックグラウンドサービスはインストール済みですが、起動が必要です。',
        backgroundServiceSubtitle: 'このコンピューターのバックグラウンドサービスをインストールして起動します。',
        backgroundServiceDetails: 'バックグラウンドサービスにより、このコンピューターは今後の起動に備えて待機状態に保たれ、選択したRelayへ自動的に再接続されます。',
        backgroundServiceReleaseChannelChildTitle: 'リリースチャネルの所有権を解決',
        backgroundServiceConflictChildTitle: '既存のバックグラウンドサービスの競合を解決',
        registerComputerTitle: 'このコンピューターを登録',
        registerComputerDoneSubtitle: 'このコンピューターはすでにあなたのアカウントに登録されています。',
        registerComputerNeedsAuthSubtitle: 'このコンピューターを登録する前にサインインしてください。',
        registerComputerReconnectSubtitle: 'サーバー設定を更新した後で、このコンピューターを再接続してください。',
        registerComputerSubtitle: '選択したサーバー上のあなたのアカウントにこのコンピューターを接続します。',
        registerComputerDetails: 'ローカルセッションやバックグラウンド機能がこのマシンを正しく識別できるように、選択したRelay上のあなたのアカウントにこのコンピューターを登録します。',
        footerHint: '低レベルのセットアップ手順はこちらで処理し、対応が必要な判断だけを表示します。',
    },
    resumeIntentTitle: 'このコンピューターでセットアップを続ける',
          resumeIntentBody: 'サインインまたはアカウント作成を行って、このコンピューターのセットアップを選択した Relay 向けに続けます。',
          openSetupAction: 'このコンピューターをセットアップ',
          openSetupWizardAction: 'セットアップウィザードを開く',
          openSetupWizardSubtitle: 'ガイド付きフローでこのコンピューターに Happier をセットアップします。',
          setupNewMachineAction: '新しいマシンをセットアップ',
          setupNewRelayAction: '新しいリレーをセットアップ',
          remoteHosts: {
              hostPickerTitle: 'リモートホスト',
              hostPickerSubtitle: '保存済みの SSH プロファイルを使うか、新しく追加します。',
              newHostOption: '新しいホスト…',
              saveHostTitle: 'このホストを保存',
              saveHostSubtitle: 'この SSH プロファイルをアカウントに保存します。',
              savePasswordTitle: 'パスワードを保存',
              savePasswordSubtitle: 'SSH パスワードを保存時に暗号化して保管します。',
              savePrivateKeyTitle: '秘密鍵を保存',
              savePrivateKeySubtitle: 'SSH の秘密鍵を保存時に暗号化して保管します。',
              privateKeyLabel: '秘密鍵',
          },
          remoteSshChecklist: {
              planTitle: 'セットアップ計画を確認',
              planSubtitleMachine: 'この計画はリモート CLI をインストールし、Relay を設定し、バックグラウンドサービスをインストールします。',
              planSubtitleRelayHost: 'この計画はリモート CLI をインストールし、Relay を設定し、Relay ランタイムをインストールします。',
              executionTitle: 'リモートマシンをセットアップ中',
              executionSubtitle: 'リモートブートストラップの実行に合わせて下のチェックリストが更新されます。',
              completeTitle: 'リモートマシンの準備完了',
              completeSubtitleMachine: 'リモートマシンのセットアップが正常に完了しました。',
              trustHostTitle: 'SSH ホストを信頼',
              trustHostSubtitle: '接続前にリモートマシンのフィンガープリントを確認します。',
              trustHostDetails: 'SSH ホストキーを検証し、明示的に信頼しない限り予期しないフィンガープリントは拒否します。',
              installCliTitle: 'Happier CLI をインストール',
              installCliSubtitle: 'Happier CLI をリモートマシンへコピーします。',
              installCliDetails: '残りのブートストラップを実行するため、リモートマシンに Happier CLI が必要です。',
              configureRelayTitle: 'Relay を設定',
              configureRelaySubtitle: 'リモートマシンをアクティブな Relay と Web アプリに向けます。',
              configureRelayDetails: 'リモート CLI をアクティブな Relay と通信し、このマシンをアカウントに認証できるよう設定します。',
              installDaemonTitle: 'バックグラウンドサービスをインストール',
              installDaemonSubtitle: 'リモートマシンで Happier をバックグラウンド実行します。',
              installDaemonDetails: 'バックグラウンドサービスはリモートマシンを接続状態に保ち、今後のセッションに備えます。',
              startFailed: 'リモートSSHのセットアップを開始できませんでした。',
              continueFailed: 'リモートSSHのセットアップを続行できませんでした。',
          },
          confirmSwitchRelayTitle: 'Relay を切り替えますか？',
          confirmSwitchRelaySubtitle: 'この Relay をアクティブにします。あとで設定から変更できます。',
          confirmSwitchRelayKeepTitle: '現在の Relay を維持',
          confirmSwitchRelayKeepSubtitle: '今は切り替えずに続行します',
          confirmSwitchRelaySwitchTitle: 'この Relay に切り替える',
          confirmSwitchRelaySwitchSubtitle: '新しい Relay では再度サインインが必要になる場合があります',
          confirmSwitchRelayWarning: '後で「設定 → Relay」から変更できます。',
      },

  review: {
    // Used by utils/requestReview.ts
    enjoyingApp: "アプリを気に入っていただけましたか？",
    feedbackPrompt: "ご意見をお聞かせください！",
    yesILoveIt: "はい、気に入りました！",
    notReally: "あまり...",
  },

	  items: {
	    // Used by Item component for copy toast
	    copiedToClipboard: ({ label }: { label: string }) =>
	      `${label}がクリップボードにコピーされました`,
	    failedToCopyToClipboard: "クリップボードへのコピーに失敗しました",
	  },

    machine: {
    launchNewSessionInDirectory: "ディレクトリで新しいセッションを起動",
    offlineUnableToSpawn: "マシンがオフラインのためランチャーは無効です",
    offlineHelp:
      "• コンピューターがオンラインであることを確認してください\n• happier daemon status を実行して診断してください\n• 最新のCLIバージョンを使用していますか？happier self update を実行してください",
    customPathPlaceholder: "カスタムパスを入力",
    tools: {
      title: "ツール",
      installablesTitle: "インストール可能",
      installablesSubtitle:
        "このマシンのインストール可能なツールを管理します。",
    },
    installables: {
      screenTitle: "インストール可能",
      aboutGroupTitle: "概要",
      aboutSubtitle:
        "このマシンで、Happier がインストールし最新状態に保てるツールを管理します。",
      experimentalGroupTitle: ({ title }: { title: string }) =>
        `${title}（実験的）`,
      autoInstallTitle: "必要時に自動インストール",
      autoInstallSubtitle:
        "選択したバックエンドで必要になったときにバックグラウンドでインストールします（ベストエフォート）。",
      autoUpdateTitle: "自動更新",
      autoUpdatePromptTitle: "自動更新",
      autoUpdatePromptBody:
        "このインストール可能項目の更新をどのように扱うか選択してください。",
      autoUpdateModes: {
        off: "オフ",
        notify: "通知",
        auto: "自動",
      },
    },
    daemon: "デーモン",
    status: "ステータス",
    daemonStatus: {
      unknown: "不明",
      stopped: "停止",
      likelyAlive: "おそらく稼働中",
    },
    stopDaemon: "デーモンを停止",
    stopDaemonConfirmTitle: "デーモンを停止しますか？",
    stopDaemonConfirmBody:
      "このマシンではデーモンを再起動するまで新しいセッションを作成できません。現在のセッションは継続します。",
    daemonStoppedTitle: "デーモンを停止しました",
    stopDaemonFailed:
      "デーモンを停止できませんでした。実行されていない可能性があります。",
    renameTitle: "マシン名を変更",
    renameDescription:
      "このマシンにカスタム名を設定します。空欄の場合はデフォルトのホスト名を使用します。",
      renamePlaceholder: "マシン名を入力",
      renamedSuccess: "マシン名を変更しました",
      renameFailed: "マシン名の変更に失敗しました",
        actions: {
          removeMachine: "マシンを削除",
          removeMachineSubtitle:
            "このマシンの権限を取り消し、アカウントから削除します。",
          removeMachineConfirmBody:
            "このマシンからのアクセス（アクセスキーやオートメーション割り当てを含む）を取り消します。後でCLIから再度サインインして再接続できます。",
          removeMachineAlreadyRemoved:
            "このマシンはすでにアカウントから削除されています。",
        },
      replacementRepair: {
        replaceWithMachine: "置き換え済みにする",
        replaceWithMachineSubtitle: ({ machine }: { machine: string }) =>
          `${machine} をこのマシンの置き換え先として使用します。`,
        chooseReplacementSubtitle: "このマシンの置き換え先を選択します。",
        pickerTitle: "置き換え先マシンを選択",
        pickerCandidatesTitle: "対象マシン",
        confirmTitle: "マシンを置き換え済みにしますか?",
        confirmBody: ({ machine }: { machine: string }) =>
          `このマシンの今後の起動と古いセッションは ${machine} を使用します。`,
        confirmAction: "置き換える",
        undo: "置き換えを取り消す",
        undoSubtitle: ({ machine }: { machine: string }) =>
          `このマシンは現在 ${machine} に置き換えられています。`,
        undoConfirmTitle: "マシンの置き換えを取り消しますか?",
        undoConfirmBody:
          "利用可能な場合、このマシンは再び起動先として表示されます。",
        undoAction: "取り消す",
        error: "マシンの置き換えを更新できませんでした。",
      },
      lastKnownPid: "最後に確認されたPID",
      lastKnownHttpPort: "最後に確認されたHTTPポート",
      startedAt: "開始時刻",
      cliVersion: "CLIバージョン",
    daemonStateVersion: "デーモン状態バージョン",
    activeSessions: ({ count }: { count: number }) =>
      `アクティブセッション (${count})`,
    machineGroup: "マシン",
    host: "ホスト",
    machineId: "マシンID",
    username: "ユーザー名",
    homeDirectory: "ホームディレクトリ",
    platform: "プラットフォーム",
    architecture: "アーキテクチャ",
    lastSeen: "最終確認",
    never: "なし",
    metadataVersion: "メタデータバージョン",
    detectedClis: "検出されたCLI",
    detectedCliDetected: "検出済み",
    detectedCliNotDetected: "未検出",
    detectedCliUnknown: "不明",
    detectedCliNotSupported: "未対応（@happier-dev/cliを更新してください）",
    untitledSession: "無題のセッション",
    back: "戻る",
    notFound: "マシンが見つかりません",
    unknownMachine: "不明なマシン",
    unknownPath: "不明なパス",
    previousSessionsTitle: "以前のセッション（直近5件まで）",
    tmux: {
      overrideTitle: "グローバル tmux 設定を上書き",
      overrideEnabledSubtitle:
        "このマシンの新しいセッションにカスタム tmux 設定が適用されます。",
      overrideDisabledSubtitle:
        "新しいセッションはグローバル tmux 設定を使用します。",
      notDetectedSubtitle: "このマシンで tmux が検出されません。",
      notDetectedMessage:
        "このマシンで tmux が検出されません。tmux をインストールして検出を更新してください。",
    },
    windows: {
      title: "Windows",
      remoteSessionConsoleTitle: "リモートセッションでコンソールを表示",
      remoteSessionConsoleVisibleSubtitle:
        "リモートセッションはこのマシンで表示されるコンソールウィンドウで開きます。",
      remoteSessionConsoleHiddenSubtitle:
        "リモートセッションはウィンドウの開閉/点滅を避けるため非表示で開始します。",
      remoteSessionConsoleUpdateFailed:
        "Windows セッションのコンソール設定を更新できませんでした。",
      remoteSessionModeTitle: "リモートセッションモード",
      remoteSessionModeOverrideTitle: "グローバルな Windows セッションモードを上書き",
      remoteSessionModeOverrideEnabledSubtitle:
        "このマシンは独自の Windows リモートセッションモードを使用します。",
      remoteSessionModeOverrideDisabledSubtitle:
        "このマシンはグローバルな Windows リモートセッションモードに従います。",
      windowsTerminalUnavailableSuffix: "このマシンでは Windows Terminal が検出されていません。",
    },

    backgroundServiceModes: {
      generic: "バックグラウンドサービス",
      defaultFollowing: "既定のバックグラウンドサービス",
      legacyPinned: "従来の固定バックグラウンドサービス",
    },
    backgroundServicePrompt: {
        targetServer: '対象サーバー',
        targetReleaseChannel: '対象リリースチャンネル',
        existingServices: '既存のサービス:',
        running: '実行中',
    },
    repairBackgroundServiceAction: "バックグラウンドサービスを修復",
    repairBackgroundServiceProgressTitle: "バックグラウンドサービスを修復中",
    runtimeInventory: 'Happier ランタイム一覧',
    runtimeInventoryOverview: '概要',
    runtimeInventoryInstallations: 'インストール',
    runtimeInventoryServices: 'サービス',
    runtimeInventoryWarnings: '警告',
    doctorRepairSummary: '修復サマリー',
    doctorRepairFindingsSummary: ({ total, warning, error, actionable }: {
        total: number;
        warning: number;
        error: number;
        actionable: number;
    }) => `${total} 件の検出結果 • 警告 ${warning} • エラー ${error} • 対応可能 ${actionable}`,
    localRelays: 'ローカル Relay',
    runtimeSummary: ({ cliVersion, daemonVersion, daemonRing, installationCount, serviceCount, warningCount }: {
        cliVersion: string;
        daemonVersion: string;
        daemonRing: string;
        installationCount: number;
        serviceCount: number;
        warningCount: number;
    }) => `CLI ${cliVersion} • daemon ${daemonVersion} (${daemonRing}) • ${installationCount} installations • ${serviceCount} services • ${warningCount} warnings`,
    transferExposure: {
      title: "転送公開",
      status: "転送公開",
      loopbackHttp: "ループバック（ローカル）",
      tailscaleServeHttps: "Tailscale Serve（HTTPS）",
      stateUnknown: "不明",
      stateDisabled: "無効",
      stateUnconfigured: "未設定",
      stateApprovalNeeded: "承認が必要",
      stateInactive: "設定済み（停止中）",
      stateStale: "設定済み（不整合）",
      stateActive: "有効",
      stateUnavailable: "利用不可",
    },},

  message: {
      sessionReferenceUnavailable: "利用できないセッション",
      sessionReferenceOpen: ({ name }: { name: string }) => `セッション ${name} を開く`,
    switchedToMode: ({ mode }: { mode: string }) =>
      `${mode}モードに切り替えました`,
    discarded: "破棄済み",
    recoveredHistory: "復元された履歴",
    pluginAttribution: ({ pluginId }: { pluginId: string }) => `プラグイン ${pluginId} から`,
    unknownEvent: "不明なイベント",
    runtimeConfigOutcomeAppliesBeforeNextMessage: '次のメッセージの前に適用されます',
    runtimeConfigOutcomeQueuedUntilReady: '準備ができるまで待機中',
    runtimeConfigOutcomeAlreadySet: 'すでに設定済み',
    runtimeConfigOutcomeSessionMode: 'セッションモード',
    runtimeConfigOutcomeKeyModel: 'モデル',
    runtimeConfigOutcomeKeyFallbackModel: 'フォールバックモデル',
    runtimeConfigOutcomeKeyPermissionMode: '権限モード',
    runtimeConfigOutcomeKeyReasoningEffort: '推論エフォート',
    runtimeConfigOutcomeKeyMaxThinkingTokens: '思考トークン上限',
    runtimeConfigOutcomeKeyLaunchOption: '起動オプション',
    runtimeConfigOutcomeRequiresRestart: '再起動が必要',
    runtimeConfigOutcomeRequiresInteractiveControl: 'ターミナルでの操作が必要',
    runtimeConfigOutcomeUnsupported: '未対応',
    runtimeConfigOutcomeFailed: '適用できませんでした',
    contextCompactionStarted: "コンテキストを圧縮中...",
    contextCompactionCompleted: "コンテキストを圧縮しました",
    contextCompactionFailed: "コンテキストの圧縮に失敗しました",
    contextCompactionCancelled: "コンテキストの圧縮をキャンセルしました",
    contextCompactionPaused: "コンテキストを圧縮しました。続行するにはメッセージを送信してください",
    usageLimitUntil: ({ time }: { time: string }) => `${time}まで使用制限中`,
    connectedServiceAccountSwitch: ({ provider, from, to }: { provider: string; from: string; to: string }) =>
      `${provider}アカウントを ${from} から ${to} に切り替えました`,
    connectedServiceGroupAccountSwitch: ({ provider, group, from, to }: { provider: string; group: string; from: string; to: string }) =>
      `${provider}グループ ${group} を ${from} から ${to} に切り替えました`,
    connectedServiceSwitchGroupSelection: ({ group, profile }: { group: string; profile: string }) =>
      `グループ ${group} · ${profile}`,
    connectedServiceSwitchProfileSelection: ({ profile }: { profile: string }) => `プロファイル ${profile}`,
    connectedServiceSwitchDeferred: 'アカウント切り替えはターン境界まで延期されました',
    connectedServiceSwitchDeferredIdle: 'アカウント切り替えはセッションがアイドル状態になるまで延期されました',
    connectedServiceSwitchDeferralCompleted: 'アカウント切り替え準備完了',
    connectedServiceSwitchDeferralCancelled: 'アカウント切り替えがキャンセルされました',
    connectedServiceSwitchDeferralSuperseded: 'アカウント切り替えが新しい切り替えに置き換えられました',
    agentStateSharingDegraded: 'プロバイダー状態共有が部分的に適用されました',
    agentQuotaWait: ({ time }: { time: string }) =>
      `${time} のプロバイダークォータリセットを待機中`,
    agentQuotaRecovered: "プロバイダークォータが復旧しました",
    connectedServiceRuntimeAuthRecoveryRecovered: "プロバイダー認証が復旧しました",
    connectedServiceRuntimeAuthRecoveryCancelled: "プロバイダー認証の復旧がキャンセルされました",
    unknownTime: "不明な時間",
  },

  chatFooter: {
    permissionsTerminalOnly:
      "権限はターミナルにのみ表示されます。リセットするかメッセージを送信して、アプリから制御してください。",
    sessionRunningLocally:
      "このセッションはこのコンピュータでローカル実行されています。アプリから制御するにはリモートに切り替えられます。",
    sessionRunningLocallyAndRemotely:
      "このセッションは OpenCode にローカル接続されたままで、アプリからも引き続き操作できます。",
    switchingToRemote: "リモートモードに切り替え中…",
    switchToRemote: "リモートに切り替え",
    detachLocalTerminal: "ターミナルを切り離す",
    directSessionTakeoverAvailable:
      "この直接セッションはあなたのマシンで利用できます。ここで操作するために Happier で引き継いでください。",
    directSessionMachineOffline:
      "この直接セッションは、マシンがオフラインのため現在利用できません。",
    switchingToDirectTakeover: "この直接セッションを引き継いでいます…",
    switchingToPersistedTakeover: "このセッションを引き継いでインポートしています…",
    takeOverDirect: "引き継ぐ",
    takeOverPersist: "引き継いでインポート",
    directTakeoverDialogTitle: "この直接セッションを Happier で続けますか？",
    directTakeoverDialogBody: "どのように Happier が制御を引き継ぐかを選択してください。Direct はプロバイダーのトランスクリプトをそのまま使い続けます。インポートはトランスクリプトを Happier に取り込みます。",
    directTakeoverDialogDirectTitle: "引き継ぐ",
    directTakeoverDialogDirectBody: "トランスクリプトを Happier にインポートせずに、このセッションを Happier で操作します。",
    directTakeoverDialogPersistTitle: "引き継いでインポート",
    directTakeoverDialogPersistBody: "トランスクリプトを Happier に取り込み、Happier セッションの機能をすべて使って続けます。",

    externalSessionTakeoverAvailable:
      "この外部セッションは Happier で引き継ぐ準備ができています。",
    externalSessionMachineOffline:
      "この外部セッションは、マシンがオフラインのため現在利用できません。",
    checkingExternalSessionTakeover: "引き継ぎオプションを確認しています…",
    externalSessionStatusUnavailable: "現在、この外部セッションを確認できません。マシンの接続を確認して、もう一度お試しください。",
    externalSessionProcessRunning: "この外部セッションの Agent はまだ実行中のようです。",
    externalSessionRecheck: "再確認",
    externalSessionTakeoverBlocked: "外部 Agent が停止したことを確認できませんでした。ターミナルで停止してから、もう一度お試しください。",},

    codex: {
      // Codex permission dialog buttons
      permissions: {
        yesAlwaysAllowCommand: "はい、グローバルに常に許可",
        yesForSession: "はい、このセッションでは確認しない",
        stop: "停止",
        stopAndExplain: "停止して、何をすべきか説明",
      },
    },

    claude: {
      // Claude permission dialog buttons
      permissions: {
        yesAllowAllEdits: "はい、このセッション中のすべての編集を許可",
        yesForTool: "はい、このツールについては確認しない",
        yesForCommandPrefix:
          "はい、このコマンドプレフィックスについては確認しない",
        yesForSubcommand: "はい、このサブコマンドについては確認しない",
        yesForCommandName: "はい、このセッションでは一致するすべてのコマンドを許可",
        stop: "停止",
        noTellClaude: "いいえ、フィードバックを提供",
      },
    },

  textSelection: {
    // Text selection screen
    selectText: "テキスト範囲を選択",
    title: "テキストを選択",
    noTextProvided: "テキストが提供されていません",
    textNotFound: "テキストが見つからないか期限切れです",
    textCopied: "テキストがクリップボードにコピーされました",
    failedToCopy: "テキストのクリップボードへのコピーに失敗しました",
    noTextToCopy: "コピーできるテキストがありません",
    failedToOpen: "テキスト選択を開けませんでした。もう一度お試しください。",
  },

  markdown: {
    // Markdown copy functionality
    codeCopied: "コードをコピーしました",
    copyFailed: "コピーに失敗しました",
    mermaidRenderFailed: "Mermaidダイアグラムのレンダリングに失敗しました",
    diffLabel: "差分",
    codeLabel: "コード",

    // Slash menu commands (Lane G)
    slash: {
        heading1: { label: '見出し 1', description: '大見出し' },
        heading2: { label: '見出し 2', description: '中見出し' },
        heading3: { label: '見出し 3', description: '小見出し' },
        bulletList: { label: '箇条書きリスト', description: '順序なしリスト' },
        orderedList: { label: '番号付きリスト', description: '順序付きリスト' },
        taskList: { label: 'タスクリスト', description: 'チェックボックス付きリスト' },
        blockquote: { label: '引用', description: '引用ブロック' },
        codeBlock: { label: 'コードブロック', description: 'コードブロック' },
        horizontalRule: { label: '区切り線', description: '水平線' },
        groups: { headings: '見出し', lists: 'リスト', blocks: 'ブロック' },
    },

    // Link bubble (Lane H)
    linkBubble: {
        open: '開く',
        edit: '編集',
        unlink: 'リンク解除',
        cancel: 'キャンセル',
        save: '保存',
        inputPlaceholder: 'リンクを貼り付けまたは入力…',
    },
  },

  // Accessibility labels for the rich markdown editor formatting toolbar.
  markdownEditorToolbar: {
    bold: "太字",
    italic: "斜体",
    strikethrough: "取り消し線",
    code: "インラインコード",
    heading1: "見出し1",
    heading2: "見出し2",
    heading3: "見出し3",
    bulletList: "箇条書きリスト",
    orderedList: "番号付きリスト",
    taskList: "タスクリスト",
    blockquote: "引用",
    codeBlock: "コードブロック",
    horizontalRule: "区切り線",
    openLink: "リンクを開く",
    unlink: "リンクを解除",
  },

    artifacts: {
    // Artifacts feature
    title: "アーティファクト",
    countSingular: "1件のアーティファクト",
    countPlural: ({ count }: { count: number }) =>
      `${count}件のアーティファクト`,
    empty: "アーティファクトはまだありません",
    emptyDescription: "最初のアーティファクトを作成して始めましょう",
    new: "新規アーティファクト",
    edit: "アーティファクトを編集",
    delete: "削除",
    updateError: "アーティファクトの更新に失敗しました。再試行してください。",
    deleteError:
      "アーティファクトを削除できませんでした。もう一度お試しください。",
    notFound: "アーティファクトが見つかりません",
    discardChanges: "変更を破棄しますか？",
    discardChangesDescription:
      "保存されていない変更があります。破棄してもよろしいですか？",
    deleteConfirm: "アーティファクトを削除しますか？",
    deleteConfirmDescription: "この操作は取り消せません",
    noContent: "内容がありません",
    untitled: "無題",
    titleLabel: "タイトル",
    titlePlaceholder: "アーティファクトのタイトルを入力",
    bodyLabel: "コンテンツ",
    bodyPlaceholder: "ここにコンテンツを書いてください...",
    emptyFieldsError: "タイトルまたはコンテンツを入力してください",
    createError: "アーティファクトの作成に失敗しました。再試行してください。",
    save: "保存",
    saving: "保存中...",
    loading: "アーティファクトを読み込み中...",
    error: "アーティファクトの読み込みに失敗しました",
  },

  friends: {
    // Friends feature
    title: "友達",
    manageFriends: "友達とつながりを管理",
    sharedSessions: "共有セッション",
    noSharedSessions: "共有セッションはまだありません",
    searchTitle: "友達を探す",
    pendingRequests: "友達リクエスト",
    myFriends: "マイフレンド",
    noFriendsYet: "まだ友達がいません",
    findFriends: "友達を探す",
    remove: "削除",
    pendingRequest: "保留中",
    sentOn: ({ date }: { date: string }) => `送信日: ${date}`,
    accept: "承認",
    reject: "拒否",
    addFriend: "友達を追加",
    alreadyFriends: "既に友達です",
    requestPending: "リクエスト保留中",
    searchInstructions: "友達を検索するにはユーザー名を入力してください",
    searchPlaceholder: "ユーザー名を入力...",
    searching: "検索中...",
    userNotFound: "ユーザーが見つかりません",
    noUserFound: "そのユーザー名のユーザーが見つかりません",
    checkUsername: "ユーザー名を確認して再試行してください",
    howToFind: "友達を見つける方法",
    findInstructions:
      "ユーザー名で友達を検索します。サーバーによっては、友達を使うためにプロバイダの接続またはユーザー名の設定が必要になる場合があります。",
    emptyTitle: "友達のアクティビティはまだありません",
    emptyDescription: "友達を追加してセッションを共有し、ここでアクティビティを確認できます。",
    activity: "アクティビティ",
    requestSent: "友達リクエストが送信されました！",
    requestAccepted: "友達リクエストが承認されました！",
    requestRejected: "友達リクエストが拒否されました",
    friendRemoved: "友達が削除されました",
    confirmRemove: "友達を削除",
    confirmRemoveMessage: "この友達を削除してもよろしいですか？",
    cannotAddYourself: "自分自身に友達リクエストを送信することはできません",
    bothMustHaveGithub:
      "友達になるには、両方のユーザーが必要なプロバイダを接続している必要があります",
    status: {
      none: "未接続",
      requested: "リクエスト送信済み",
      pending: "リクエスト保留中",
      friend: "友達",
      rejected: "拒否済み",
    },
    acceptRequest: "リクエストを承認",
    removeFriend: "友達を削除",
    removeFriendConfirm: ({ name }: { name: string }) =>
      `${name}さんを友達から削除してもよろしいですか？`,
    requestSentDescription: ({ name }: { name: string }) =>
      `${name}さんに友達リクエストが送信されました`,
    requestFriendship: "友達リクエストを送信",
    cancelRequest: "友達リクエストをキャンセル",
    cancelRequestConfirm: ({ name }: { name: string }) =>
      `${name}さんへの友達リクエストをキャンセルしますか？`,
    denyRequest: "友達リクエストを拒否",
    nowFriendsWith: ({ name }: { name: string }) =>
      `${name}さんと友達になりました`,
    disabled: "このサーバーでは友達機能が無効です。",
    username: {
      required: "友達を使うにはユーザー名を設定してください。",
      taken: "そのユーザー名は既に使用されています。",
      invalid: "そのユーザー名は使用できません。",
      disabled:
        "このサーバーではユーザー名ベースの友達機能が有効になっていません。",
      preferredNotAvailable:
        "希望するユーザー名はこのサーバーで利用できません。別のものを選んでください。",
      preferredNotAvailableWithLogin: ({ login }: { login: string }) =>
        `希望するユーザー名 @${login} はこのサーバーで利用できません。別のものを選んでください。`,
    },
    githubGate: {
      title: "友達を使うには GitHub 連携が必要です",
      body: "友達は GitHub のユーザー名で検索・共有します。",
      connect: "GitHub を連携",
      notAvailable: "利用できない？",
      notConfigured: "このサーバーでは GitHub OAuth が設定されていません。",
    },
    providerGate: {
      title: ({ provider }: { provider: string }) =>
        `友達を使うには ${provider} 連携が必要です`,
      body: ({ provider }: { provider: string }) =>
        `友達は ${provider} のユーザー名で検索・共有します。`,
      connect: ({ provider }: { provider: string }) => `${provider} を連携`,
      notAvailable: "利用できない？",
      notConfigured: ({ provider }: { provider: string }) =>
        `このサーバーでは ${provider} OAuth が設定されていません。`,
    },
  },

  usage: {
    // Usage panel strings
    today: "今日",
    last7Days: "過去7日間",
    last30Days: "過去30日間",
    totalTokens: "合計トークン",
    totalCost: "合計コスト",
    tokens: "トークン",
    cost: "コスト",
    usageOverTime: "使用量の推移",
    byModel: "モデル別",
    noData: {
      title: "使用データがありません",
      subtitle: "最初のセッション後、使用状況データがここに表示されます。",
    },
    errors: {
      notAuthenticated: "使用状況を表示するにはサインインしてください。",
      failedToLoad: "使用状況を読み込めませんでした。",
    },

    lastYear: "過去1年",
    costMode: "コストモード",
    auto: "自動",
    reported: "レポート値",
    estimated: "推定値",
    insights: "インサイト",
    activity: "アクティビティ",
    timeline: "タイムライン",
    leaders: "ランキング",
    activeDays: "アクティブ日数",
    modelsTried: "試したモデル",
    favoriteModelChanges: "よく使うモデルの変化",
    busiestWindow: "最も活発な時間帯",
    activityCalendarSubtitle: "カレンダーヒートマップ",
    mostActiveMonths: "選択期間で最も活発だった月",
    dailyActivity: "選択期間の日別アクティビティ",
    mostActiveWeekdays: "最も活発だった曜日",
    mostActiveHours: "最も活発だった時間帯",
    events: "イベント",
    source: "ソース",
    sessionUsage: "セッション使用量",
    longestStreak: '最長ストリーク',
    dailyRhythm: '1日のリズム',
    eventsLabel: 'イベント',
    daysShort: ({ count }: { count: number }) => `${count}d`,
    updatedCaption: 'たった今更新',
    whenYouWork: '作業する時間帯',
    periodTodayShort: '今日',
    period7dShort: '7日',
    period30dShort: '30日',
    periodYearShort: '1年',
    busiestTag: '最多',
    vsPreviousPeriod: '前期間比',
    workRhythm: '作業リズム',
    weeks: "週",
    messagesCaption: ({ count }: { count: number }) => `${count.toLocaleString()} メッセージ`,
    modelMix: {
        title: "モデル構成の推移",
        other: "その他",
    },
    showAll: 'すべて表示',
    showLess: '折りたたむ',
    exportCsv: 'CSV をダウンロード',
    efficiency: {
        cacheHitRate: 'キャッシュヒット率',
        cacheHitCaption: 'キャッシュから提供された入力トークンの割合',
        costPerMtok: '100万トークンあたりのコスト',
        costPerMtokCaption: '100万トークンあたりの実効ブレンドレート',
    },

    cacheSavings: 'キャッシュ節約',
    banner: {
        lifetimeTokens: '累計トークン',
        peakTokens: 'ピークトークン',
        tokenActivity: 'トークンアクティビティ',
        daily: '日次',
        weekly: '週次',
        cumulative: '累積',
        activityInsights: 'アクティビティの分析',
        mostUsed: 'よく使う項目',
        days: ({ count }: { count: number }) => `${count}日`,
    },
    tokenMix: {
        input: '入力',
        output: '出力',
        reasoning: '推論',
        cacheRead: 'キャッシュ読み取り',
        cacheWrite: 'キャッシュ書き込み',
    },
    recap: {
        play: 'リキャップを再生',
        shareImage: '画像として共有',
    },
    context: {
        title: 'コンテキストと効率',
        utilization: '使用中のコンテキスト',
        window: 'ウィンドウ',
        tokenMixTitle: 'トークン構成',
    },
    summary: {
      title: "使用状況の概要",
      currentStreak: "現在の連続記録",
      currentStreakSubtitle: ({ count }: { count: number }) => `${count} active days in the last 30`,
      currentStreakSubtitleForPeriod: ({ count, period }: { count: number; period: string }) => `${count} active days · ${period}`,
      thisWeek: "今週",
      thisWeekSubtitle: "直近の勢い",
      topModel: "よく使うモデル",
      engine: "エンジン",
      export: {
        session: "セッション",
        period: "期間",
        metric: "指標",
        costMode: "コストモード",
        totalTokens: "合計トークン",
        totalCost: "合計コスト",
        activeDays: "アクティブ日数",
        topModel: "トップモデル",
        topEngine: "主要エンジン",
        modelTimeline: "モデルのタイムライン",
        engineTimeline: "エンジンのタイムライン",
      },
    },},

  secrets: {
    addTitle: "新しいシークレット",
    savedTitle: "保存済みシークレット",
    badgeReady: "シークレット",
    badgeRequired: "シークレットが必要",
    missingForProfile: ({ env }: { env: string | null }) =>
      `シークレットがありません（${env ?? "シークレット"}）。マシンで設定するか、シークレットを選択/入力してください。`,
    defaultForProfileTitle: "デフォルトのシークレット",
    defineDefaultForProfileTitle:
      "このプロフィールのデフォルトシークレットを設定",
    addSubtitle: "保存済みシークレットを追加",
    noneTitle: "なし",
    noneSubtitle:
      "マシン環境を使用するか、このセッション用にシークレットを入力してください",
    emptyTitle: "保存済みシークレットがありません",
    emptySubtitle:
      "マシンの環境変数を設定せずにシークレットが必要なプロファイルを使うには、追加してください。",
    savedHiddenSubtitle: "保存済み（値は非表示）",
    defaultLabel: "デフォルト",
    fields: {
      name: "名前",
      value: "値",
    },
    placeholders: {
      nameExample: "例: Work OpenAI",
      valueExample: "sk-...",
    },
    validation: {
      nameRequired: "名前は必須です。",
      valueRequired: "値は必須です。",
    },
    actions: {
      replace: "置き換え",
      replaceValue: "値を置き換え",
      setDefault: "デフォルトに設定",
      unsetDefault: "デフォルト解除",
    },
    prompts: {
      renameTitle: "シークレット名を変更",
      renameDescription: "このシークレットの表示名を更新します。",
      replaceValueTitle: "シークレットの値を置き換え",
      replaceValueDescription:
        "新しいシークレットの値を貼り付けてください。保存後は再表示されません。",
      deleteTitle: "シークレットを削除",
      deleteConfirm: ({ name }: { name: string }) =>
        `「${name}」を削除しますか？元に戻せません。`,
    },
  },

  feed: {
    // Feed notifications for friend requests and acceptances
    friendRequestFrom: ({ name }: { name: string }) =>
      `${name}さんから友達リクエストが届きました`,
    friendRequestGeneric: "新しい友達リクエスト",
    friendAccepted: ({ name }: { name: string }) =>
      `${name}さんと友達になりました`,
    friendAcceptedGeneric: "友達リクエストが承認されました",
  },

    projects: {
    emptyTitle: "プロジェクトはまだありません",
    emptyDescription: "プロジェクトでは、セッション外でマシン上のファイルを閲覧・編集し、Git を使えます。",
    groups: {
      pinned: "ピン留め",
      addFirst: "プロジェクトを追加",
    },
    actions: {
      addProjectToMachine: "このマシンにプロジェクトを追加",
      addProject: "プロジェクトを追加",
      addProjectOnMachine: ({ machine }: { machine: string }) => `${machine} でプロジェクトを追加`,
      chooseProjectFolderOnMachine: ({ machine }: { machine: string }) => `${machine} 上のフォルダーを選択`,
      chooseProjectFolderSubtitle: "プロジェクトとして追加して、ファイルを閲覧・編集し、Git を使います。",
      pin: "ピン留め",
      unpin: "ピン留めを解除",
      remove: "削除",
    },
    sourceControl: {
      noSessionAvailableDetails: "このフォルダでセッションを開始すると、プロジェクトでソース管理を有効にできます。",
    },
    details: {
      emptyBody: "ファイルまたはソース管理を開くと、ここにファイルや差分のプレビューが表示されます。",
      placeholderFileBody: "「{title}」のファイルプレビューがここに表示されます。",
      placeholderScmReviewBody: "差分のプレビューがここに表示されます。",
      placeholderCommitBody: "コミットの詳細がここに表示されます。",
      placeholderUnsupportedBody: "この詳細タブはまだプロジェクトではサポートされていません。",
    },
    detail: {
      notFoundTitle: "プロジェクトが見つかりません",
      notFoundDescription: "このプロジェクトは削除されたか、別のサーバーに属している可能性があります。",
      missingWorktreeRecovered: "選択した worktree はもう存在しません。プロジェクトルートに戻しました。",
      groupTitle: "プロジェクト",
      fields: {
        name: "名前",
        machine: "マシン",
        path: "パス",
      },
      comingSoonGroupTitle: "近日公開",
      comingSoonFooter:
        "次のリファクタリング段階で、ファイル、ソース管理、差分、ターミナルがここに表示されます。",
      comingSoon: {
        filesAndScmTitle: "ファイルとソース管理",
        filesAndScmSubtitle:
          "この画面は既存のサイドバーと詳細ペインを再利用しますが、セッションではなくワークスペースにスコープされます。",
      },
    },
  },
   settingsPlugins: {
      ...pluginWebhookAdministrationTranslations['ja'],
      ...pluginAccountDataEraseTranslations.ja,
      ...pluginAccountReleaseSelectionTranslations.ja,
      ...pluginInvocationLogTranslations.ja,
      ...eventAutomationComposerTranslations.ja,
    title: "プラグイン カタログ",
    subtitle: "厳選されたプラグイン記述子を確認し、この端末でインストール済みプラグインを管理できます。",
    appPanelsTitle: "プラグインパネル",
    appPanelsSubtitle: "インストール済みプラグインが追加したアプリパネルを開きます。",
    executionOriginReleaseContentConflict: "リリース内容が一致しません。新しいバージョンを公開してください。",
    readOnlyProjectionUnavailable: "キャッシュされたプラグインの詳細は読み取り専用です。この端末には接続できますが、プラグインレジストリを読み込めませんでした。プラグインを管理するには再試行してください。",
    readOnlyAccountRecovery: "プラグインのアカウント詳細は利用できますが、互換性のあるプラグインのインストールが利用可能になるまで、この端末固有の詳細は利用できません。",
    readOnlySnapshot: "この端末が切断されている間、キャッシュされたプラグインの詳細は読み取り専用です。プラグインを管理するには再接続してください。",
    viewSelectorLabel: "プラグイン管理ビュー",
    views: { installed: "インストール済み", discover: "見つける", development: "開発", diagnostics: "診断" },
    developmentTitle: "開発",
    developmentFooter: "この端末から報告された承認済みローカルソースと開発診断です。",
    developmentEmpty: "開発ソースは報告されていません",
    developmentEmptySubtitle: "この端末から承認済みローカルソースまたは監視と再読み込みの診断は報告されていません。",
    developmentCreate: "プラグインを作成",
    developmentCreateSubtitle: "このマシンにローカルプラグインのひな形を作成します。",
    developmentCreateSucceeded: "プラグインのひな形を作成しました。",
    developmentSourceInstall: "ローカルのプラグインフォルダーを開発する",
    developmentSourceInstallSubtitle: "このマシンのデーモンが、あなたのフォルダーからプラグインをビルドして実行できるようにします。まず対象のフォルダーを承認します。",
    developmentSourceInstallTitle: "プラグインフォルダー",
    developmentSourceInstallBody: "このマシン上のプラグインプロジェクトフォルダーの絶対パスを入力してください。",
    developmentSourceInstallSucceeded: "開発ソースを承認し、投影しました。",
    developmentSourceInstallFailed: ({ outcome }: { outcome: string }) => `開発ソースをインストールできませんでした（${outcome}）。`,
    developmentTrustSourceRootTitle: "このプラグインフォルダーを信頼しますか？",
    developmentTrustSourceRootBody: ({ path }: { path: string }) => `Happier は次の場所で依存関係をインストールし、コードをビルドして実行します:\n\n${path}\n\nそのフォルダー内のすべてと、そこから取得されうるすべてを信頼できる場合にのみ続行してください。プラグイン自体は次のステップで確認します。`,
    developmentTrustSourceRootConfirm: "フォルダーを信頼",
    developmentCreateDirectoryTitle: "プラグインフォルダー",
    developmentCreateDirectoryBody: "選択したマシン上の新しい絶対パスを入力してください。フォルダーは未作成である必要があります。",
    developmentCreateNameTitle: "プラグイン名",
    developmentCreateNameBody: "プラグインの表示名を入力してください。",
    developmentCreateIdTitle: "プラグイン ID",
    developmentCreateIdBody: "happier.* 以外の、小文字かつドット区切りの所有者名前空間を入力してください。",
    developmentCreateSurfaceTitle: "プラグイン UI サーフェス",
    developmentCreateSurfaceBody: "このプラグインが最初に持つ UI サーフェスを選択します。React Native は Web でも描画されます。",
    developmentCreateSurfaceReactNative: "React Native",
    developmentCreateSurfaceHostedWeb: "ホスト型 Web",
    developmentCreateSurfaceNone: "UI なし",
    developmentCreateConfirmTitle: "プラグインのひな形を作成しますか？",
    developmentCreateConfirmBody: ({ pluginId, targetDir }: { pluginId: string; targetDir: string }) => `${targetDir} に ${pluginId} を作成しますか？`,
    developmentWatchConfigured: "監視の承認を設定済み",
    developmentReloadClear: "現在の再読み込み診断はありません",
    developmentReloadAttention: "再読み込み診断を確認してください",
    developmentTest: "プラグインをテスト",
    developmentTestSubtitle: "Happier の管理ランタイムでビルド済みエントリポイントを確認します。",
    developmentTestSucceeded: "プラグインのテストに成功しました。",
    developmentPack: "プラグインをパック",
    developmentPackSubtitle: "承認済みソースフォルダーの隣に検証済みインストールアーカイブを作成します。",
    developmentPackSucceeded: "ソースフォルダーの隣にパッケージを作成しました。",
    diagnosticsSnapshotTitle: "診断",
    diagnosticsSnapshotFooter: "この端末のプラグインレジストリから現在報告されている診断です。",
    diagnosticsSnapshotEmpty: "現在のプラグイン診断はありません",
    diagnosticsSnapshotEmptySubtitle: "この端末から現在のレジストリ診断が報告されると、ここに表示されます。",
    catalogUrlLabel: "カタログ URL",
    loadCatalog: "カタログを読み込む",
    installAndTrust: "インストールして信頼",
    marketplaceWithdrawnTitle: "マーケットプレイスから取り下げ済み",
    marketplaceWithdrawnBody: "この掲載は選定済みマーケットプレイスから取り下げられました。新規インストールと更新はブロックされています。",
    marketplaceWithdrawnInstalledBody: "この掲載は選定済みマーケットプレイスから取り下げられました。新規インストールと更新はブロックされています。インストール済みのプラグインは、無効化またはアンインストールするまで有効なままです。",
    trustPolicy: {
      localTrusted: "ローカルで信頼済み",
      trusted: "信頼済み",
      prompt: "承認が必要",
      untrusted: "信頼されていません",
    },
    sourceKind: {
      bundled: "同梱",
      path: "ローカルパス",
      marketplace: "マーケットプレイス",
      package: "パッケージレジストリ",
      archive: "アーカイブ",
      catalog: "カタログ",
    },
    unknownValue: ({ value }: { value: string }) => `その他: ${value}`,
    emptySubtitle: "このカタログには記述子がありません。",
    detailTitle: "プラグインの詳細",
    managePlugin: "プラグインを管理",
    provenanceTitle: "ソースと信頼",
    diagnosticsTitle: "プラグイン診断",
    registryDiagnosticsTitle: "レジストリ診断",
    contributionsTitle: "投影されたコントリビューション",
    unsupportedDescriptorField: "この記述子フィールドは、このバージョンの Happier ではサポートされていません。",
    noDescriptors: "このセクションには、ホストでレンダリングされる記述子が投影されていません。",
    marketplaceInstallReviewTitle: ({ name, version }: { name: string; version: string }) => `${name} ${version} をインストールして信頼しますか？`,
    marketplaceInstallReviewBlockedNewerVersions: 'より新しいバージョンはダウンロード前にブロックされました：',
    marketplaceInstallReviewRawCredentialAccess: ({ details }: { details: string }) => `生の Voice 認証情報アクセス:\n${details}`,
    marketplaceInstallReviewRawCredentialAccessItem: ({ contribution, credential, source, realm, phase, request }: { contribution: string; credential: string; source: string; realm: string; phase: string; request: string }) =>
      `${contribution}: ${credential}。ソース ${source}、ランタイム ${realm}、フェーズ ${phase}、リクエスト ${request}。${realm} ランタイムのプラグインコードは選択した認証情報を直接受け取り、使用またはコピーできます。`,
    marketplaceInstallReviewBody: ({ identity, verification, executableRealms, contributions, uiArtifacts, requiredAccess, optionalAccess, compatibility }: { identity: string; verification: string; executableRealms: string; contributions: string; uiArtifacts: string; requiredAccess: string; optionalAccess: string; compatibility: string }) => `識別情報:\n${identity}\n\n検証シグナル:\n${verification}\n\n実行可能コード: ${executableRealms}\nコントリビューション: ${contributions}\nUI アーティファクト: ${uiArtifacts}\n\n信頼されたデーモンおよび React Native コードは、アプリまたはプロセスの権限で実行され、ファイル、ネットワーク、環境、プロセスを直接使用できます。以下のホストアクセスは Happier が仲介するサービスを示すものであり、実行可能なプラグインコードのサンドボックスではありません。\n\n必須の開示と協調サービス:\n${requiredAccess}\n\n任意のホスト所有リソース（既定ではオフ）:\n${optionalAccess}\n\n互換性と更新:\n${compatibility}`,
    marketplaceInstallDecisionFailed: ({ outcome }: { outcome: string }) => `プラグインはインストールされませんでした（${outcome}）。`,
    marketplaceChangeDecisionFailed: ({ action, outcome }: { action: string; outcome: string }) => `${action}に失敗しました（${outcome}）。`,
    pluginChangeConfirmBody: ({ action, name }: { action: string; name: string }) => `${name} に対する「${action}」を確認してください。`,
    forgetTrust: "信頼を解除",
    rollback: "ロールバック",
    uninstall: "アンインストール",
    marketplaceUpdateVersion: ({ installedVersion, availableVersion }: { installedVersion: string; availableVersion: string }) => `バージョン ${installedVersion} から ${availableVersion} に更新します。`,
    marketplaceCommunityUnreviewedTitle: "未審査のコミュニティコード",
    marketplaceCommunityUnreviewedBody: "このサードパーティ製 npm パッケージは Happier による審査を受けていません。「インストールして信頼」は、デーモンがこの正確なバージョンと整合性を検証した後、宣言された実行可能コードとホストアクセスを承認します。信頼されたデーモンおよび React Native コードはアプリまたはプロセスの権限で実行され、表示されるホストアクセスはサンドボックスではありません。",
    genericSettingsTitle: "プラグイン設定",
    genericSettingsFooter: "このマシン上で、このプラグイン用にローカル保存されます。",
    genericSettingsLoading: "プラグイン設定を読み込み中",
    genericSettingsUnavailable: "このマシンではプラグイン設定を利用できません。",
    genericSettingsLoadError: "プラグイン設定を読み込めませんでした。",
    genericSettingsSaveError: "プラグイン設定を保存できませんでした。",
    genericSettingsEmpty: "このプラグインには編集可能な設定がありません。",
    registriesTitle: "プライベート npm レジストリ",
    registriesFooter: "レジストリへのサインインはパッケージアクセスのみを制御します。レジストリを削除またはサインアウトしても、インストール済みで信頼済みのプラグインは利用できます。",
    registriesAdd: "レジストリを追加",
    registriesAddTitle: "プライベートレジストリを追加",
    registriesAddOriginBody: "認証情報を含まない HTTPS レジストリのオリジンを入力してください。",
    registriesInvalidOriginTitle: "レジストリのオリジンが無効です",
    registriesInvalidOriginBody: "パス、クエリ、フラグメント、認証情報を含まない HTTPS オリジンを使用してください。",
    registriesNameTitle: "レジストリ名",
    registriesNameBody: "Happier の設定内だけに表示される名前を選択してください。",
    registriesScopesTitle: "パッケージスコープ",
    registriesScopesBody: "このレジストリに送る任意のスコープをカンマ区切りで入力します。",
    registriesScopesPlaceholder: "@company-jp, @team-jp",
    registriesDefaultTitle: "既定のパッケージレジストリ",
    registriesDefaultBody: "別の設定済みソースに送られないスコープなしパッケージに、このレジストリを使用しますか？",
    registriesUseAsDefault: "既定として使用",
    registriesScopedOnly: "スコープ付きパッケージのみ",
    registriesPrivateNetworkTitle: "プライベートネットワークアクセス",
    registriesPrivateNetworkBody: "このレジストリのオリジンがプライベートまたはローカルネットワークのアドレスを解決することを許可しますか？インターネット上のレジストリではオフのままにしてください。",
    registriesAllowPrivateNetwork: "プライベートネットワークを許可",
    registriesPublicOnly: "公開アドレスのみ",
    registriesLogin: "サインイン",
    registriesLoginTitle: "レジストリトークン",
    registriesLoginBody: "このレジストリのトークンを貼り付けてください。選択したマシンで暗号化され、このアプリには保存されません。",
    registriesLogout: "サインアウト",
    registriesEdit: "レジストリを編集",
    registriesTest: "接続をテスト",
    registriesMarketplaceBindingsTitle: "マーケットプレイスのレジストリ関連付け",
    registriesMarketplaceBind: ({ profile, source }: { profile: string; source: string }) => `${source} に ${profile} を使用`,
    registriesMarketplaceUnbind: ({ source }: { source: string }) => `${source} でプライベートレジストリの使用を停止`,
    registriesRemove: "レジストリを削除",
    registriesRemoveTitle: "プライベートレジストリを削除しますか？",
    registriesRemoveBody: ({ name }: { name: string }) => `${name} を削除しますか？インストール済みのプラグインはインストール済みかつ信頼済みのままですが、このレジストリからの今後のダウンロードと更新は一時停止されます。`,
    registriesAvailability: {
      unknown: "未確認",
      available: "利用可能",
      sign_in_required: "サインインが必要",
      offline: "オフライン",
    },
    registriesUpdatePaused: "更新は一時停止中",
    registriesPauseReason: {
      credentials_missing: "レジストリの認証情報がありません",
      authentication_failed: "レジストリの認証に失敗しました",
      profile_removed: "レジストリプロファイルが削除されました",
      offline: "レジストリはオフラインです",
    },
    registriesErrorTitle: "レジストリ操作に失敗しました",
    registriesErrorBody: "レジストリ一覧を更新して、もう一度お試しください。",
    registriesInvalidProfileTitle: "レジストリ設定が無効です",
    registriesInvalidProfileBody: "レジストリ名とパッケージスコープを確認して、もう一度お試しください。",
    registriesNoMachine: "プライベートレジストリを管理するマシンを選択してください。",
    registriesLoadError: "プライベートレジストリの設定を読み込めませんでした。",
    registriesEmpty: "プライベートレジストリは設定されていません。",
  },
    settingsScmDiffSummary: {
  title: '差分サマリー',
  enabledTitle: '差分サマリーを有効化',
  enabledSubtitle: 'ソース管理の差分に AI 生成サマリーを許可します。',
  prefetchTitle: 'サマリーを先読み',
  prefetchSubtitle: 'この設定が有効な場合にのみ、サマリーを事前生成します。',
  modelOverrideTitle: 'サマリーモデル',
  modelOverrideSubtitle: '差分サマリーに使う任意の解決済みランタイムプロファイル。',
  modelOverrideDefault: 'ランタイムの既定値を使用',
  cacheTitle: 'サマリーキャッシュ',
  cacheSubtitle: 'チェックポイントのサマリーは受領 ID で再利用され、working tree のサマリーは一時的に扱われます。',
  },
    externalSessions: {
        ...externalSessionOperationTranslations.ja,
        ...externalSessionSettingsTranslations.ja,
        settingsTitle: '外部セッション',
        settingsEntrySubtitle: 'アプリの外で開始されたセッションを Happier がどう扱うか確認します。',
        settingsSafetyGroupTitle: '仕組み',
        settingsPassiveTitle: 'デフォルトでは読み取り専用',
        settingsPassiveSubtitle: 'このページを開く操作は受動的です。Agent の開始や再開、設定変更、フックのインストール、セッションのフォロー開始は行いません。',
        settingsFollowGroupTitle: 'パッシブフォロー',
        settingsRestoreTitle: '再起動後もパッシブフォローを維持',
        settingsRestoreEnabledSubtitle: 'デーモンの再起動時に、明示的にフォローしているセッションへ再接続します。',
        settingsRestoreDisabledSubtitle: 'デーモンの再起動後はフォロー中のセッションへ再接続しません。',
        settingsRestoreFooter: '復元は既存の Agent ソースを監視するだけです。Agent を開始または再開することはありません。',
        settingsNotificationsTitle: '通知',
        settingsNotificationsActiveSubtitle: '準備完了通知は、パッシブフォローが有効なセッションにのみ適用されます。',
        settingsNotificationsInactiveSubtitle: 'セッションのパッシブフォローを有効にすると、その通知を受け取れます。',
        settingsActiveFollowsGroupTitle: 'セッションのフォロー',
        settingsActiveFollowsFooter: '各選択はそのセッションだけに適用されます。他のセッションが自動的に有効になることはありません。',
        settingsActiveFollowsEmptyTitle: '外部セッションはまだありません',
        settingsActiveFollowsEmptySubtitle: 'リンクされた外部セッションと現在のフォロー状態がここに表示されます。',
        settingsFollowToggleHint: 'このセッションのバックグラウンドでのパッシブフォローを開始または停止します。',
        followStatusDisabled: 'フォローしていません',
        followStatusPaused: 'フォローは一時停止中',
        followStatusReacquiring: 'フォローを再接続中…',
        followStatusActive: 'フォロー中',
        followStatusError: 'フォローに対応が必要です',
        followStatusUnknown: 'フォロー状態を確認できません',
        followStatusMachineOffline: 'マシンはオフラインです。再接続するとパッシブフォローが再開します',
        followStatusUnsupported: 'この Agent はパッシブフォローに対応していません',
        followUpdateFailed: 'このセッションのパッシブフォローを更新できませんでした。もう一度お試しください。',
    browseTitle: "外部セッションを参照",
    browseOpenExisting: "外部セッションを参照",
    browseActionSubtitle: "ここで開くマシン、エージェント、セッションを選択します。",
    emptyStateTitle: "既存のセッションを参照",
    emptyStateDescription: "接続済みのマシンから Claude、Codex、OpenCode のセッションを開きます。",
    browseFiltersTitle: "ソースを選択",
    browseMachines: "マシン",
    browseAgents: "エージェント",
    browseSources: "ソース",
    browseSourceCodexUserHome: "自分の Codex ホーム",
        browseSourceCodexConnectedServices: ({ service }: { service: string }) => `${service} の接続済みサービス`,
    browseSourceClaudeDefault: "デフォルトの Claude 設定",
    browseSourceOpenCodeDefault: "デフォルトの OpenCode サーバー",
    browseCandidates: "利用可能なセッション",
    browseNoMachines: "直接セッションに利用できるマシンはまだありません。",
    browseNoCandidates: "このマシンとエージェントに対する外部セッションは見つかりませんでした。",
    browseActivityRunning: "実行中",
        browseActivityRunningNow: "実行中",
    browseActivityRecent: "最近アクティブ",
    browseActivityIdle: "アイドル",
    browseActivityUnknown: "不明",
        browseSearchPlaceholder: "読み込み済みセッションを検索…",
        browseNoSearchResults: "この検索に一致する読み込み済みセッションはまだありません。",
    browseIndexing: "外部セッションをインデックスしています…",
    browseIndexingProgress: ({ scanned, total }: { scanned: number; total: number }) => `${total} 件中 ${scanned} 件をインデックス済み`,
    browseIndexingCancelled: "インデックス作成を停止しました。準備ができたら再試行してください。",
    browseLoadMore: "さらにセッションを読み込む",
    browseFailedToLoad: "外部セッションの読み込みに失敗しました。",
    browseLinkFailed: "選択した外部セッションのリンクに失敗しました。",
  },
    pluginReactNative: {
    unavailable: "プラグインの React Native UI を利用できません",
    disabled: "プラグインの React Native UI は無効です",
    fallback: "プラグインのフォールバックを使用しています",
    reset: {
      requested: {
        title: "プラグイン UI をリセットしています",
        reason: "Happier はリセットの確認を待機しています。",
      },
      awaitingProjection: {
        title: "プラグインのリセットを待機しています",
        reason: "Happier は更新されたプラグインの状態を待機しています。",
      },
      complete: {
        title: "プラグイン UI のリセットが完了しました",
        reason: "プラグイン UI を再び利用できます。",
      },
      failed: {
        title: "プラグイン UI をリセットできませんでした",
        reason: "もう一度リセットしてください。",
      },
    },
  },
    pluginRuntime: {
        unavailableGeneric: 'このプラグインビューは現在利用できません。',
        crashLoop: 'クラッシュが繰り返されたため、プラグインを停止しました。',
        disabledByPolicy: '現在の設定または互換性により、このプラグインビューは無効になっています。',
        hostedWebUnavailableTitle: 'ホストされたプラグインビューは利用できません',
        hostedWebPolicyDenied: 'このプラグインビューはこの画面では利用できません。利用可能設定を確認するか、対応している画面を使用してください。',
        hostedWebSandboxUnavailable: 'このプラグインには、このビューを表示するために必要な分離設定が宣言されていません。プラグインを更新して、もう一度お試しください。',
        hostedWebSecurityUnavailable: 'このビューでは、プラグインのセキュリティ設定を適用できません。プラグインを更新するか、対応しているホストを使用してください。',
        hostedWebFrameOriginUnavailable: 'Happier はこのビューの信頼できるアドレスを確立できませんでした。更新して、もう一度お試しください。',
        hostedWebBridgeNonceUnavailable: 'Happier はこのビューへの安全な接続を確立できませんでした。更新して、もう一度お試しください。',
        hostedWebBridgeTimeout: 'このプラグインビューは接続を完了できませんでした。更新して、もう一度お試しください。',
        hostedWebEndpointPolicyDenied: 'このビューのアドレスはセキュリティポリシーによってブロックされています。プラグイン設定を確認するか、対応しているホストを使用してください。',
        missingRequirement: 'このデバイスでは、このプラグインビューに必要な要件が満たされていません。',
    },
    settingsSearch: {
    placeholder: "設定を検索",
  },
    onboardingJourney: {
        accessibility: {
            skipToContent: "コンテンツに移動",
        },
  },} as const;
