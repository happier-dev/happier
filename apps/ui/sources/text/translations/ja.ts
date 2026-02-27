/**
 * Japanese translations for the Happier app
 * Values can be:
 * - String constants for static text
 * - Functions with typed object parameters for dynamic text
 */

import type { TranslationStructure } from "../_types";

export const ja: TranslationStructure = {
  tabs: {
    // Tab navigation labels
    inbox: "友達",
    sessions: "ターミナル",
    settings: "設定",
  },

  inbox: {
    // Inbox screen
    emptyTitle: "友達のアクティビティはまだありません",
    emptyDescription:
      "友達を追加してセッションを共有し、ここでアクティビティを確認できます。",
    updates: "アクティビティ",
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
        name: "スケジュール済みセッション",
        description: "このオートメーションは何をしますか？",
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
      runMeta: {
        scheduled: ({ time }: { time: string }) => `スケジュール: ${time}`,
        updated: ({ time }: { time: string }) => `更新: ${time}`,
        error: ({ message }: { message: string }) => `エラー: ${message}`,
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

  common: {
    // Simple string constants
    add: "追加",
    edit: "編集",
    actions: "操作",
    moreActions: "その他の操作",
    moreActionsHint: "追加の操作メニューを開きます",
    cancel: "キャンセル",
    close: "閉じる",
    done: "完了",
    authenticate: "認証",
    save: "保存",
    error: "エラー",
    success: "成功",
    ok: "OK",
    continue: "続行",
    back: "戻る",
    start: "開始",
    create: "作成",
    rename: "名前を変更",
    remove: "削除",
    update: "更新",
    commit: "コミット",
    history: "履歴",
    applied: "適用済み",
    signOut: "サインアウト",
    keep: "保持",
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
    command: "コマンド",
    scanning: "スキャン中...",
    urlPlaceholder: "https://example.com",
    home: "ホーム",
    message: "メッセージ",
    send: "送信",
    attach: "添付",
    linkFile: "ファイルをリンク",
    files: "ファイル",
    path: "パス",
    fileViewer: "ファイルビューアー",
    loading: "読み込み中...",
    none: "—",
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
  },

  ui: {
    resizableDockedPane: {
      resizeA11y: "パネルのサイズを変更",
      resizeHint: "左右の矢印キーでサイズを変更できます",
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
          "`claude` を実行し、`/login` と入力してログインしてください。",
        warning:
          "注意: `ANTHROPIC_AUTH_TOKEN` を設定すると CLI ログインを上書きします。",
      },
      codex: {
        title: "Codex",
        instructions: "`codex login` を実行してログインしてください。",
      },
      geminiCli: {
        title: "Gemini CLI",
        instructions: "`gemini auth` を実行してログインしてください。",
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
    defaultSessionType: "デフォルトのセッションタイプ",
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
      piSubtitleExperimental: "Pi CLI（実験）",
      copilotSubtitleExperimental: "GitHub Copilot CLI（実験的）",
    },
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
    offline: "オフライン",
    lastSeen: ({ time }: { time: string }) => `最終アクセス: ${time}`,
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
  },

  connect: {
    restoreAccount: "アカウントを復元",
    enterSecretKey: "シークレットキーを入力してください",
    invalidSecretKey:
      "シークレットキーが無効です。確認して再試行してください。",
    enterUrlManually: "URLを手動で入力",
    scanComputerQrInstructions: "パソコンの Happier（設定 → スマホを追加）に表示されたQRコードをスキャンします。",
    scanComputerQrButton: "QRをスキャンしてサインイン",
    waitingForApproval: "承認待ち…",
    showQrInstead: "代わりにQRコードを表示",
    addPhoneQrInstructions: "Happier モバイルアプリでこのQRコードをスキャンして、スマホでサインインします。",
    pairingRequestTitle: "ペアリング要求",
    pairingRequestBody: "スマホに表示されたコードと一致することを確認してから承認してください。",
    deviceLabel: "デバイス",
    confirmCodeLabel: "確認コード",
    approveButton: "承認",
    generateNewQrCode: "新しいQRコードを生成",
    openMachine: "マシンを開く",
    terminalUrlPlaceholder: "happier://terminal?...",
    restoreQrInstructions:
      "1. モバイル端末で Happier を開く\n2. 設定 → アカウント に移動\n3. 「新しいデバイスをリンク」をタップ\n4. この QR コードをスキャン",
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
    linkNewDeviceTitle: "新しいデバイスをリンク",
    linkNewDeviceSubtitle: "新しいデバイスに表示されているQRコードをスキャンしてこのアカウントにリンクしてください",
    linkNewDeviceQrInstructions: "新しいデバイスでHappierを開いてQRコードを表示してください",
    scanQrCodeOnDevice: "QRコードをスキャン",
    unsupported: {
      connectTitle: ({ name }: { name: string }) => `${name} を接続`,
      runCommandInTerminal: "ターミナルで次のコマンドを実行してください:",
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
            "UIからマシンに接続できない場合、PCで `happier doctor --json` を実行してここに貼り付けてください。",
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
      groupTitle: "埋め込み",
      groupFooter:
        "任意: Deep モード使用時の意味検索精度を上げるため、ローカルモデルをダウンロードします。",
      enableTitle: "埋め込みを有効化",
      enableSubtitle:
        "深い検索のランキングを改善します（初回使用時にモデルをダウンロードします）",
      modelTitle: "埋め込みモデル",
      promptBody: "ローカルの transformers モデル ID を入力してください。",
      modelPlaceholder: "Xenova/all-MiniLM-L6-v2",
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
    },
  },

  settings: {
    title: "設定",
    connectedAccounts: "接続済みアカウント",
    connectedAccountsDisabled: "接続サービスは無効になっています。",
    connectAccount: "アカウントを接続",
    github: "GitHub",
    machines: "マシン",
    features: "機能",
    social: "ソーシャル",
    account: "アカウント",
    accountSubtitle: "アカウントの詳細を管理",
    addYourPhone: "スマホを追加",
    addYourPhoneSubtitle: "スマホでサインインするためのQRコードを表示します",
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
    developer: "開発者",
    developerTools: "開発者ツール",
    about: "このアプリについて",
    actionsSettingsAboutSubtitle:
      "アクションをグローバルに、サーフェス（UI/音声/MCP）別、配置（UI 内の表示場所）別に有効/無効にできます。無効化されたアクションは実行時に安全側（フェイルクローズ）でブロックされます。",
    aboutFooter:
      "Happier CoderはCodexとClaude Codeのモバイルクライアントです。完全なエンドツーエンド暗号化を採用し、アカウントはデバイスにのみ保存されます。Anthropicとは提携していません。",
    whatsNew: "新機能",
    whatsNewSubtitle: "最新のアップデートと改善を確認",
    reportIssue: "問題を報告",
    privacyPolicy: "プライバシーポリシー",
    termsOfService: "利用規約",
    eula: "EULA",
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
    servers: "サーバー",
    serversSubtitle: "保存済みサーバー、グループ、既定値",
    systemStatus: "システム状態",
    systemStatusSubtitle: "サーバー、アカウント、マシン、デーモン",

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
  },

  systemStatus: {
    sections: {
      appHealth: "アプリ + 同期の状態",
      currentServer: "現在のサーバー",
      identity: "サインイン情報",
      configuredServers: "設定済みサーバー",
      machinesActiveServer: "マシン（アクティブサーバー）",
      machinesOtherServer: ({ server }: { server: string }) => `マシン（${server}）`,
      actions: "アクション",
    },
    ui: {
      dataReady: "データ準備完了",
      realtime: "リアルタイム",
      socket: "ソケット",
      socketLastError: ({ error }: { error: string }) => `最後のエラー: ${error}`,
      lastSync: "最終同期",
    },
    server: {
      activeServer: "アクティブサーバー",
    },
    identity: {
      accountId: "アカウントID",
      username: "ユーザー名",
    },
    servers: {
      noneConfigured: "サーバーが設定されていません",
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
        loading: "デーモンのサーバー/アカウントを取得中…",
        invalid: "マシンから doctor スナップショットを取得できませんでした",
      },
      daemonAttributionUnknown: "デーモンのサーバー/アカウント: 不明",
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
      runDiagnosisSubtitle: "サーバー/アカウント/デーモンの不一致を検出",
      refreshMachineAttribution: "マシンのデーモン情報を更新",
      refreshMachineAttributionSubtitle: "オンラインのマシンからデーモンのサーバー/アカウントを取得",
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
      activeServer: "アクティブサーバー",
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
      footer: "ヒント: PCで `happier doctor --json` を実行して貼り付けてください。",
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
    title: "接続済みサービス",
    authChip: {
      label: "認証",
      labelWithCount: ({ count }: { count: number }) => `認証: ${count}`,
    },
    list: {
      empty: "接続済みサービスはまだありません。",
      connectedCount: ({ count }: { count: number }) => `${count} 件接続済み`,
      needsReauth: "再認証が必要",
      notConnected: "未接続",
    },
    quota: {
      loading: "読み込み中…",
      error: ({ message }: { message: string }) => `エラー: ${message}`,
      lastUpdated: ({ time }: { time: string }) => `最終更新: ${time}`,
      lastUpdatedStale: ({ time }: { time: string }) => `最終更新: ${time} • 古い`,
      noData: "クォータデータはまだありません",
      planLabel: ({ plan }: { plan: string }) => `プラン: ${plan}`,
    },
    oauthPaste: {
      invalidConfig: "接続済みサービスの設定が無効です。",
      connectWebGroupTitle: "接続（Web）",
      connectWebDescription:
        "このフローは、コピー/貼り付けのリダイレクト手順（OpenClaw のようなもの）と Happier サーバーのプロキシを使って、トークンを安全に交換します。",
      openAuthorizationUrl: "認可 URL を開く",
      opensInNewTab: "新しいタブで開きます",
      preparing: "準備中…",
      pasteRedirectUrl: "リダイレクト URL を貼り付け",
      pasteRedirectUrlPromptBody:
        "OAuth を完了したら、ブラウザのアドレスバーに表示されている最終的なリダイレクト URL をコピーして、ここに貼り付けてください。",
      working: "処理中…",
      alerts: {
        connectedTitle: "接続済み",
        connectedBody: ({ serviceId, profileId }: { serviceId: string; profileId: string }) =>
          `${serviceId}（${profileId}）を接続しました。`,
        failedToConnect: "接続に失敗しました",
      },
    },
    detail: {
      unknownService: "不明な接続済みサービスです。",
      actionsGroupTitle: "操作",
      setDefaultProfileTitle: "既定のプロファイルを設定",
      setDefaultProfileSubtitleDefault: ({ profileId }: { profileId: string }) =>
        `既定: ${profileId}`,
      setDefaultProfileSubtitleChoose:
        "既定で選択されるプロファイルを選択します",
      setProfileLabelTitle: "プロファイルラベルを設定",
      setProfileLabelSubtitle: "認証ピッカーに表示される任意のラベル",
      addOauthProfileTitle: "OAuthプロファイルを追加",
      addOauthProfileSubtitle: "新しいアカウントプロファイルを接続",
      connectSetupTokenTitle: "setup-token で接続",
      connectSetupTokenSubtitle: "Claude の setup-token を貼り付け",
      disconnectConfirmBody: ({ service, profileId }: { service: string; profileId: string }) =>
        `「${service}（${profileId}）」を切断しますか？`,
      prompts: {
        profileIdTitle: "プロファイルID",
        profileIdBody: "work / personal / alt のような短いラベルを使ってください。",
        setupTokenTitle: "セットアップトークン",
        setupTokenBody: "Claude の setup-token を貼り付けてください。",
        profileLabelTitle: "プロファイルラベル",
        profileLabelBody: "任意。認証ピッカーに表示されます。",
        profileLabelPlaceholder: "仕事用アカウント",
      },
      alerts: {
        invalidProfileIdTitle: "無効なプロファイルID",
        invalidProfileIdBody:
          "英数字、ハイフン、アンダースコア（最大64）を使用してください。",
        unknownProfileTitle: "不明なプロファイル",
        unknownProfileBody: ({ profileId, service }: { profileId: string; service: string }) =>
          `「${profileId}」というプロファイルは ${service} に存在しません。`,
      },
      profiles: {
        empty: "プロファイルはまだありません。",
        connected: "接続済み",
        defaultBadge: "既定",
        needsReauth: "再認証が必要",
      },
    },
    authModal: {
      nativeAuthTitle: "バックエンドのネイティブ認証",
      nativeAuthSubtitle: "ローカルCLIログイン / APIキーを使用",
      connectedServicesTitle: "接続済みサービスを使用",
      connectedServicesSubtitle: "Happierクラウドから取得して反映",
      notConnectedTitle: "未接続",
      notConnectedSubtitle: "タップして設定を開く",
      profileLabel: "プロファイル",
    },
  },

  attachments: {
    alerts: {
      fileTooLargeTitle: "ファイルが大きすぎます",
      fileTooLargeBody: ({ count }: { count: number }) =>
        `最大添付サイズを超えるため、${count} 件のファイルをスキップしました。`,
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
          "`.happier/uploads` のような相対パスを使用してください。",
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
      uploadTtl: {
        title: "アップロード TTL（ms）",
        promptTitle: "アップロード TTL（ms）",
        promptMessage:
          "アップロードが期限切れになるまでアイドル状態でいられる時間。",
        invalidValueMessage: "5000 から 3600000 の間の数値を入力してください。",
      },
      chunkSize: {
        title: "推奨チャンクサイズ（バイト）",
        promptTitle: "推奨チャンクサイズ（バイト）",
        promptMessage: "CLI が安全な範囲に丸める場合があります。",
        invalidValueMessage: "4096 から 1048576 の間の数値を入力してください。",
      },
    },
  },

  settingsSourceControl: {
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
      },
    },
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

  settingsNotifications: {
    push: {
      title: "プッシュ通知",
      footer:
        "これらの通知は、セッションに注意が必要なときに CLI から Expo 経由で送信されます。",
      enabledSubtitle: "このアカウントでプッシュ通知を許可します",
    },
    types: {
      title: "種類",
      footer: "必要な通知だけ受け取りたい場合は種類ごとに無効化できます。",
      ready: {
        title: "準備完了",
        subtitle:
          "ターンが完了し、エージェントがあなたのコマンドを待っているときに通知します",
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
  },

	  notifications: {
	    actions: {
	      allow: '許可',
	      deny: '拒否',
	      answer: '回答',
	    },
	    channels: {
	      default: 'デフォルト',
	      permissionRequests: '権限リクエスト',
	      userActionRequests: 'アクションリクエスト',
	    },
	  },

  settingsProviders: {
	    title: "AIプロバイダー設定",
	    entrySubtitle: "プロバイダー固有のオプションを設定します",
	    footer:
      "プロバイダー固有のオプションを設定します。これらの設定はセッションの動作に影響する場合があります。",
    providerSubtitle: "プロバイダー固有の設定",
	    stateEnabled: "有効",
	    stateDisabled: "無効",
	    channelStable: "安定版",
	    channelExperimental: "実験版",
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
	    resumeSupportRuntimeGatedAcpLoadSession:
	      "ACP loadSession による実行時ゲート",
	    resumeSupportNotSupported: "未対応",
	    sessionModeNone: "ACP モードなし",
	    sessionModeAcpPolicyPresets: "ACP ポリシープリセット",
	    sessionModeAcpAgentModes: "ACP エージェントモード",
	    runtimeSwitchNone: "実行時切り替えなし",
	    runtimeSwitchMetadataGating: "メタデータによるゲート",
	    runtimeSwitchAcpSetSessionMode: "ACP: setSessionMode",
	    runtimeSwitchProviderNative: "プロバイダー固有",
	    modelsTitle: "モデル",
	    modelSelectionTitle: "モデル選択",
	    freeformModelIdsTitle: "自由入力モデルID",
	    defaultModelTitle: "デフォルトモデル",
	    catalogModelListTitle: "カタログモデル一覧",
	    catalogModelListEmpty: "利用可能なカタログモデルがありません",
	    dynamicModelProbeTitle: "動的モデルプローブ",
	    dynamicModelProbeAuto: "自動",
	    dynamicModelProbeStaticOnly: "静的のみ",
	    nonAcpApplyScopeTitle: "非ACP モデル適用範囲",
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
	    installInfoSeeSetupGuide: "セットアップガイドを見る",
	    installInfoUseProviderCliInstaller: "プロバイダーの CLI インストーラーを使用",
      cliInstaller: {
        installTitle: ({ provider }: { provider: string }) => `${provider} CLI をインストール`,
        reinstallTitle: ({ provider }: { provider: string }) => `${provider} CLI を再インストール`,
        autoInstallUnavailable: "このマシンでは自動インストールを利用できません。",
        installSubtitle:
          "選択したマシンにプロバイダー CLI をインストールします（ベストエフォート）。",
        reinstallSubtitle:
          "CLI が既に存在する場合でも、プロバイダーのインストーラーを再実行します。",
        noMachineSelected: "マシンが選択されていません。",
        installNotSupported: "このマシンではインストールに対応していません。",
        installFailed: "インストールに失敗しました。",
        installed: "インストール済み。",
        logPath: ({ logPath }: { logPath: string }) => `ログ: ${logPath}`,
      },
	    setupGuideUrlTitle: "セットアップガイド URL",
	    connectedServiceTitle: "接続済みサービス",
	    notFoundTitle: "プロバイダーが見つかりません",
    notFoundSubtitle: "このプロバイダーには設定画面がありません。",
    noOptionsAvailable: "利用可能なオプションはありません",
    invalidNumber: "無効な数値です",
    invalidJson: "無効なJSONです",
  },

  settingsAppearance: {
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
    multiPanePanels: "右パネル",
    multiPanePanelsDescription:
      "ファイルとソース管理のための右側パネルを表示（Web/タブレット）",
    detailsPaneTabsBehavior: "エディタのタブ",
    detailsPaneTabsBehaviorDescription:
      "エディタパネル内のファイルタブの挙動を選択します",
    detailsPaneTabsBehaviorOptions: {
      preview: "プレビュータブ",
      persistent: "固定タブ",
    },
    editorFocusMode: "エディタ集中モード",
    editorFocusModeDescription:
      "ファイル確認中は会話とサイドバーを隠します（Web/タブレット）",
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
    },
    showFlavorIcons: "AIプロバイダーアイコンを表示",
    showFlavorIconsDescription:
      "セッションアバターにAIプロバイダーアイコンを表示",
    compactSessionView: "コンパクトセッション表示",
    compactSessionViewDescription:
      "アクティブなセッションをコンパクトなレイアウトで表示",
    compactSessionViewMinimal: "最小コンパクト表示",
    compactSessionViewMinimalDescription:
      "アバターを非表示にして、より小さなセッション行レイアウトで表示",
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
  },

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
    expShowThinkingMessages: "思考メッセージを表示",
    expShowThinkingMessagesSubtitle:
      "チャットでアシスタントの思考/ステータスメッセージを表示",
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
    expConnectedServices: "連携サービス",
    expConnectedServicesSubtitle: "連携サービスの設定とセッション連携を有効化",
    expConnectedServicesQuotas: "連携サービスのクォータ",
    expConnectedServicesQuotasSubtitle:
      "連携サービスのクォータバッジと使用量メーターを表示",
    expMemorySearch: "メモリ検索",
    expMemorySearchSubtitle: "ローカルメモリ検索の画面と設定を有効化",
    expFriends: "友だち",
    expFriendsSubtitle: "友だち機能（受信箱タブとセッション共有）を有効化",
    webFeatures: "Web機能",
    webFeaturesDescription: "Webバージョンでのみ利用可能な機能。",
    enterToSend: "Enterで送信",
    enterToSendEnabled: "Enterで送信（Shift+Enterで改行）",
    enterToSendDisabled: "Enterで改行",
    historyScope: "メッセージ履歴",
    historyScopePerSession: "履歴をターミナルごとに切替",
    historyScopeGlobal: "履歴を全ターミナルで共有",
    historyScopeModalTitle: "メッセージ履歴",
    historyScopeModalMessage:
      "ArrowUp/ArrowDown で、このターミナル内のみの送信履歴を巡回するか、全ターミナルの履歴を巡回するかを選択します。",
    historyScopePerSessionOption: "ターミナルごと",
    historyScopeGlobalOption: "グローバル",
    commandPalette: "コマンドパレット",
    commandPaletteEnabled: "⌘Kで開く",
    commandPaletteDisabled: "クイックコマンドアクセスは無効",
    markdownCopyV2: "Markdownコピー v2",
    markdownCopyV2Subtitle: "長押しでコピーモーダルを開く",
    hideInactiveSessions: "非アクティブセッションを非表示",
    hideInactiveSessionsSubtitle: "アクティブなチャットのみをリストに表示",
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
	    fileNotFound: "ファイルが見つかりません",
	    invalidFormat: "フォーマットが無効です",
	    operationFailed: "操作に失敗しました",
	    daemonUnavailableTitle: "デーモンを利用できません",
	    daemonUnavailableBody:
	      "このマシン上のデーモンに接続できません。オフライン、起動中、またはサーバーから切断されている可能性があります。",
	    tryAgain: "再試行してください",
	    contactSupport: "問題が続く場合はサポートにお問い合わせください",
	    sessionNotFound: "セッションが見つかりません",
	    voiceSessionFailed: "音声セッションの開始に失敗しました",
	    voiceServiceUnavailable: "音声サービスは一時的に利用できません",
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
      "このマシンには Codex resume がインストールされていません",
    codexResumeNotInstalledMessage:
      "Codex の会話を再開するには、対象のマシンに Codex resume サーバーをインストールしてください（マシン詳細 → Installables）。",
    codexAcpNotInstalledTitle:
      "このマシンには Codex ACP がインストールされていません",
    codexAcpNotInstalledMessage:
      "Codex ACP の実験機能を使うには、対象のマシンに codex-acp をインストールしてください（マシン詳細 → Installables）。または実験機能を無効にしてください。",
  },

  deps: {
    installNotSupported:
      "この依存関係をインストールするには Happier CLI を更新してください。",
    installFailed: "インストールに失敗しました",
    installed: "インストールしました",
    installLog: ({ path }: { path: string }) => `インストールログ: ${path}`,
    installable: {
      codexResume: {
        title: "Codex 再開サーバー",
        installSpecTitle: "Codex resume のインストール元",
      },
      codexAcp: {
        title: "Codex ACP アダプター",
        installSpecTitle: "Codex ACP のインストール元",
      },
      installSpecDescription:
        "（実験的）`npm install` に渡す NPM/Git/ファイル指定。空欄の場合はデーモンの既定を使用します。",
    },
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
      installSpecPlaceholder:
        "例: file:/path/to/pkg または github:owner/repo#branch",
      lastInstallLog: "前回のインストールログ",
      installLogTitle: "インストールログ",
    },
  },

  newSession: {
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
    selectSessionTypeTitle: "セッションタイプを選択",
    selectSessionTypeDescription:
      "シンプルなセッション、またはGitのワークツリーに紐づくセッションを選択してください。",
    searchPathsPlaceholder: "パスを検索...",
    noMachinesFound:
      "マシンが見つかりません。まずコンピューターでHappierセッションを起動してください。",
    allMachinesOffline: "すべてのマシンがオフラインです",
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
      "セッションの開始に失敗しました。ターゲットマシンでデーモンが実行中か確認してください。",
    sessionTimeout:
      "セッションの開始がタイムアウトしました。マシンが遅いか、デーモンが応答していない可能性があります。",
    notConnectedToServer:
      "サーバーに接続されていません。インターネット接続を確認してください。",
    daemonRpcUnavailableTitle: "デーモンを利用できません",
    daemonRpcUnavailableBody:
      "このマシン上のデーモンに接続できません。オフライン、起動中、またはサーバーから切断されている可能性があります。",
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
      recentTitle: "最近",
      favoritesTitle: "お気に入り",
      suggestedTitle: "おすすめ",
      allTitle: "すべて",
      emptyRecent: "最近のパスはありません",
      emptyFavorites: "お気に入りのパスはありません",
      emptySuggested: "おすすめのパスはありません",
      emptyAll: "パスがありません",
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
    },
    resume: {
      title: "セッションを再開",
      optional: "再開: 任意",
      pickerTitle: "セッションを再開",
      subtitle: ({ agent }: { agent: string }) =>
        `再開する${agent}セッションIDを貼り付けてください`,
      placeholder: ({ agent }: { agent: string }) =>
        `${agent}セッションIDを貼り付け…`,
      paste: "貼り付け",
      save: "保存",
      clearAndRemove: "クリア",
      helpText: "セッションIDは「セッション情報」画面で確認できます。",
      cannotApplyBody:
        "この再開IDは現在適用できません。代わりに新しいセッションを開始します。",
    },
    codexResumeBanner: {
      title: "Codex 再開",
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
      installTitle: "Codex resume をインストールしますか？",
      updateTitle: "Codex resume を更新しますか？",
      reinstallTitle: "Codex resume を再インストールしますか？",
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
  },

  sessionHistory: {
    // Used by session history screen
    title: "セッション履歴",
    empty: "セッションが見つかりません",
    today: "今日",
    yesterday: "昨日",
    daysAgo: ({ count }: { count: number }) => `${count}日前`,
    viewAll: "すべてのセッションを表示",
  },

  session: {
    inputPlaceholder: "メッセージを入力...",
    activity: "アクティビティ",
    resuming: "再開中...",
    resumeFailed: "セッションの再開に失敗しました",
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
      actionMenu: {
        openA11y: "セッションの操作を開く",
      },
	    detailsPanel: {
	      emptyHint: "右側パネルからファイルまたは差分を開いてください。",
	      unsupportedTab: "未対応の詳細タブです。",
	      closeA11y: "詳細を閉じる",
          openTabA11y: ({ title }: { title: string }) => `${title} を開く`,
          pinTabA11y: "タブを固定",
          pinnedTabA11y: "固定されたタブ",
          closeTabA11y: "タブを閉じる",
          enterFocusModeA11y: "エディタ集中モードに入る",
          exitFocusModeA11y: "エディタ集中モードを終了",
	    },
	
	    actionsDraft: {
	      noInputHints: "このアクションには入力ヒントがありません。",
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
        untriaged: "未分類",
        accept: "承認",
        reject: "却下",
        defer: "保留",
        needsRefinement: "要精査",
      },
      refinementPlaceholder: "精査のための任意コメント",
      actions: {
        applyTriage: "分類を適用",
        applying: "適用中…",
        applyAcceptedFindings: "承認済み結果を適用",
        sending: "送信中…",
      },
      errors: {
        applyTriageFailed: "分類の適用に失敗しました。",
        applyAcceptedFailed: "承認済み結果の適用に失敗しました。",
      },
    },

	    pendingMessages: {
	      title: "保留中メッセージ",
        indicator: ({ count }: { count: number }) => `保留中 (${count})`,
        badgeLabel: ({ count }: { count: number }) =>
          count > 0 ? `保留中 (+${count})` : "保留中",
	      empty: "保留中のメッセージはありません。",
	      actions: {
	        up: "上へ",
	        down: "下へ",
	        edit: "編集",
	        steerNow: "今すぐ挿入",
	        sendNow: "今すぐ送信",
	        sendNowInterrupt: "今すぐ送信（中断）",
	        requeue: "キューに戻す",
	      },
	      editPrompt: {
	        title: "保留中メッセージを編集",
	      },
	      removeConfirm: {
	        title: "保留中メッセージを削除しますか？",
	        body: "保留中メッセージを削除します。",
	      },
	      steerConfirm: {
	        title: "今すぐ挿入しますか？",
	        body: "現在のターンを止めずに、このメッセージを現在のターンに追加します。",
	      },
	      sendConfirm: {
	        title: "今すぐ送信しますか？",
	        interruptTitle: "今すぐ送信（中断）しますか？",
	        body: "現在のターンを停止し、このメッセージをすぐに送信します。",
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
      recipientMissingKeys: "このユーザーはまだ暗号化キーを登録していません。",
      permissionApprovals: "権限を承認できる",
      allowPermissionApprovals: "権限承認を許可",
      allowPermissionApprovalsDescription:
        "このユーザーが権限リクエストを承認し、あなたのマシンでツールを実行できるようにします。",
      permissionApprovalsDisabledTitle: "権限承認は無効です",
      permissionApprovalsDisabledPublic:
        "公開リンクは閲覧専用です。権限承認は利用できません。",
      permissionApprovalsDisabledReadOnly: "このセッションは閲覧専用です。",
      permissionApprovalsDisabledNotGranted:
        "オーナーはこのセッションでの権限承認を許可していません。",
      publicReadOnlyTitle: "公開リンク（閲覧専用）",
      publicReadOnlyBody:
        "このセッションは公開リンクで共有されています。メッセージとツール出力は閲覧できますが、操作や権限承認はできません。",

      publicLink: "公開リンク",
      publicLinkActive: "公開リンクが有効です",
      publicLinkDescription:
        "誰でもこのセッションを閲覧できるリンクを作成します。",
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
    effectiveLabel: ({ label }: { label: string }) => `適用中: ${label}`,
  },

  voiceAssistant: {
    connecting: "接続中...",
    active: "音声アシスタントが有効です",
    connectionError: "接続エラー",
    label: "音声アシスタント",
    tapToEnd: "タップして終了",
  },

  voiceSurface: {
    start: "開始",
    stop: "停止",
    selectSessionToStart: "音声を開始するセッションを選択してください",
    targetSession: "ターゲットセッション",
    noTarget: "セッションが選択されていません",
    clearTarget: "ターゲットをクリア",
    a11y: {
      teleport: "音声エージェントをテレポート",
      toggleActivity: "音声アクティビティを切り替え",
      clearActivity: "音声アクティビティをクリア",
    },
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

  server: {
    // Used by Server Configuration screen (app/(app)/server.tsx)
    serverConfiguration: "サーバー設定",
    enterServerUrl: "サーバーURLを入力してください",
    notValidHappyServer: "有効なHappier Serverではありません",
    changeServer: "サーバーを変更",
    continueWithServer: "このサーバーで続行しますか？",
    resetToDefault: "デフォルトにリセット",
    resetServerDefault: "サーバーをデフォルトにリセットしますか？",
    validating: "検証中...",
    validatingServer: "サーバーを検証中...",
    serverReturnedError: "サーバーがエラーを返しました",
    failedToConnectToServer: "サーバーへの接続に失敗しました",
    currentlyUsingCustomServer: "現在カスタムサーバーを使用中",
    customServerUrlLabel: "カスタムサーバーURL",
    advancedFeatureFooter:
      "これは高度な機能です。何をしているか理解している場合のみサーバーを変更してください。サーバー変更後は再度ログインが必要です。",
    useThisServer: "このサーバーを使用",
    autoConfigHint:
      "セルフホストの場合: まずサーバーを設定し、サインイン（またはアカウント作成）してから、ターミナルを接続してください。",
    renameServer: "サーバー名を変更",
    renameServerPrompt: "このサーバーの新しい名前を入力してください。",
    renameServerGroup: "サーバーグループ名を変更",
    renameServerGroupPrompt:
      "このサーバーグループの新しい名前を入力してください。",
    serverNamePlaceholder: "サーバー名",
    cannotRenameCloud: "クラウドサーバーの名前は変更できません。",
    removeServer: "サーバーを削除",
    removeServerConfirm: ({ name }: { name: string }) =>
      `保存済みサーバーから「${name}」を削除しますか？`,
    removeServerGroup: "サーバーグループを削除",
    removeServerGroupConfirm: ({ name }: { name: string }) =>
      `保存済みサーバーグループから「${name}」を削除しますか？`,
    cannotRemoveCloud: "クラウドサーバーは削除できません。",
    signOutThisServer: "このサーバーからもサインアウトしますか？",
    signOutThisServerPrompt:
      "この端末に、このサーバーの保存済み認証情報が見つかりました。",
    savedServersTitle: "保存済みサーバー",
    signedIn: "サインイン済み",
    signedOut: "サインアウト済み",
    authStatusUnknown: "認証状態が不明",
    switchToServer: "このサーバーに切り替え",
    active: "アクティブ",
    default: "デフォルト",
    addServerTitle: "サーバーを追加",
    switchForThisTab: "このタブのみ切り替え",
    makeDefaultOnDevice: "この端末のデフォルトにする",
    serverNameLabel: "サーバー名",
    addAndUse: "追加して使用",
    addTargetsTitle: "追加",
    addServerSubtitle: "新しいサーバーを追加して切り替え",
    notificationAddServerHint: "このサーバーはまだこの端末に保存されていません。続行するには下で追加してください。",
    serverCount: ({ count }: { count: number }) => `${count} サーバー`,
    signedOutSwitchConfirmTitle: "接続されていません",
    signedOutSwitchConfirmBody:
      "このサーバーに切り替えてホーム画面へ進み、サインインまたはアカウント作成を行いますか？",
    addServerGroupTitle: "サーバーグループを追加",
    addServerGroupSubtitle: "再利用可能なサーバーのグループを作成",
    serverGroupNameLabel: "グループ名",
    serverGroupNamePlaceholder: "自分のサーバーグループ",
    serverGroupServersLabel: "サーバー",
    saveServerGroup: "グループを保存",
    serverGroupMustHaveServer:
      "サーバーグループには少なくとも1つのサーバーが必要です。",
    multiServerView: {
      title: "複数サーバー同時表示",
      footer: "複数のサーバーを 1 つのセッション一覧にまとめるか選択します。",
      enableTitle: "同時表示を有効化",
      enableSubtitle: "選択したサーバーのセッションをまとめて表示します",
      presentationTitle: "表示モード",
      presentation: {
        flatWithBadges: "サーバーバッジ付きのフラット一覧",
        groupedByServer: "サーバーごとにグループ化",
      },
    },
  },

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
  },

  sessionInfo: {
    // Used by Session Info screen (app/(app)/session/[id]/info.tsx)
    killSession: "セッションを終了",
    killSessionConfirm: "このセッションを終了してもよろしいですか？",
    stopSession: "セッションを停止",
    stopSessionConfirm: "このセッションを停止してもよろしいですか？",
    archiveSession: "セッションをアーカイブ",
    archiveSessionConfirm: "このセッションをアーカイブしてもよろしいですか？",
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
    piSessionId: "Pi セッション ID",
    piSessionIdCopied: "Pi セッション ID をクリップボードにコピーしました",
    copilotSessionId: "Copilot セッション ID",
    copilotSessionIdCopied:
      "Copilot セッション ID をクリップボードにコピーしました",
    metadataCopied: "メタデータがクリップボードにコピーされました",
    failedToCopyMetadata: "メタデータのコピーに失敗しました",
    failedToKillSession: "セッションの終了に失敗しました",
    failedToStopSession: "セッションの停止に失敗しました",
    failedToArchiveSession: "セッションのアーカイブに失敗しました",
    connectionStatus: "接続状態",
    created: "作成日時",
    lastUpdated: "最終更新",
    sequence: "シーケンス",
    quickActions: "クイックアクション",
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
      "npm install -g @happier-dev/cli@latest を実行してください",
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
    failedToRenameSession: "セッション名の変更に失敗しました",
    sessionRenamed: "セッション名を変更しました",
  },

  components: {
    emptyMainScreen: {
      // Used by SessionGettingStartedGuidance component
      readyToCode: "コーディングを始めますか？",
      installCli: "Happier CLIをインストール",
      runIt: "実行する",
      scanQrCode: "QRコードをスキャン",
      openCamera: "カメラを開く",
      installCommand: "$ npm i -g @happier-dev/cli",
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
    dropToAttach: "ドロップして添付",
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
      safeYolo: "セーフYOLO",
      yolo: "YOLO",
      plan: "プランモード",
      bypassPermissions: "Yoloモード",
      badgeAccept: "許可",
      badgePlan: "プラン",
      badgeReadOnly: "読み取り専用",
      badgeSafeYolo: "セーフYOLO",
      badgeYolo: "YOLO",
      badgeAcceptAllEdits: "すべての編集を許可",
      badgeBypassAllPermissions: "すべての権限をバイパス",
      badgePlanMode: "プランモード",
    },
    agent: {
      claude: "Claude",
      codex: "Codex",
      opencode: "OpenCode",
      gemini: "Gemini",
      auggie: "Auggie",
      qwen: "Qwen Code",
      kimi: "Kimi",
      kilo: "Kilo",
      pi: "Pi",
      copilot: "Copilot",
    },
    auggieIndexingChip: {
      on: "インデックス有効",
      off: "インデックス無効",
    },
    model: {
      title: "モデル",
      useCliSettings: "CLI設定を使用",
      configureInCli: "CLIの設定でモデルを構成",
      customDescription: "一覧にないモデルIDを使用します。",
      customPromptBody: "モデルIDを入力してください",
      customPlaceholder: "例: claude-3.5-sonnet",
    },
    codexPermissionMode: {
      title: "CODEX権限モード",
      default: "CLI設定",
      plan: "プランモード",
      readOnly: "読み取り専用モード",
      safeYolo: "セーフYOLO",
      yolo: "YOLO",
      badgePlan: "プラン",
      badgeReadOnly: "読み取り専用モード",
      badgeSafeYolo: "セーフYOLO",
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
    },
    suggestion: {
      fileLabel: "ファイル",
      folderLabel: "フォルダ",
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
      currentValue: ({ value }: { value: string }) => `現在: ${value}`,
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
  },

  tools: {
    common: {
      more: ({ count }: { count: number }) => `+${count} 件`,
      elapsedSeconds: ({ seconds }: { seconds: string }) => `${seconds}s`,
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
    taskView: {
      initializing: "エージェントを初期化中...",
      moreTools: ({ count }: { count: number }) => `+${count} 個のツール`,
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
    notRepo: "ソース管理リポジトリではありません",
    notUnderSourceControl: "このディレクトリはソース管理下にありません",
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
	    fileWriteFailed: "ファイルを書き込めませんでした",
      fileEditor: {
        experimentalHint:
          "編集は実験的です。保存すると変更がセッションの worktree に書き戻されます。",
      },
	    fileEditingUnsupported:
	      "接続されたデーモンはファイル編集をサポートしていません。書き込み操作を有効にするには、マシン上のHappierを更新してください。",
	    selectionFailed: "選択を更新できませんでした",
	    openReviewCommentsFailed: "レビューコメントを開けませんでした",
        reviewComments: {
          title: ({ count }: { count: number }) => `レビューコメント (${count})`,
          placeholder: "レビューコメントを追加…",
          jump: "ジャンプ",
          addCommentA11y: "コメントを追加",
          closeCommentA11y: "コメントを閉じる",
          draftsChipLabel: ({ count }: { count: number }) => `レビュー (${count})`,
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
          commit: "コミット",
          generateFailed: "コミットメッセージを生成できませんでした",
          generatorDisabled: "コミットメッセージ生成が無効です",
        },
	    loadingFile: ({ fileName }: { fileName: string }) =>
	      `${fileName}を読み込み中...`,
	    binaryFile: "バイナリファイル",
	    cannotDisplayBinary: "バイナリファイルの内容を表示できません",
	    diff: "差分",
    file: "ファイル",
    diffModes: {
      pending: "保留中",
      included: "含めた",
      combined: "統合",
    },
    fileActions: {
      selectForCommit: "コミット対象に選択",
      stageFile: "ファイルをステージ",
      removeFromSelection: "選択から削除",
      unstageFile: "ステージ解除",
      selectionHint:
        "行選択を有効にするには「含めた」または「保留中」を選択してください。",
      selectedLines: {
        selectLinesForCommit: "コミット対象の行を選択",
        stageSelectedLines: "選択した行をステージ",
        unstageSelectedLines: "選択した行のステージ解除",
      },
      clearSelection: "選択をクリア",
    },
    toolbar: {
      changedFiles: "変更されたファイル",
      allRepositoryFiles: "リポジトリ内のすべてのファイル",
      repositoryView: "リポジトリ表示",
      sessionView: "セッション表示",
      review: "レビュー",
      list: "一覧",
      scm: "Git",
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
    },
  },

  executionRuns: {
    newRun: {
      headerTitle: "実行を開始",
      sections: {
        intent: "目的",
        permissions: "権限",
        backends: "バックエンド",
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
        toggleBackend: ({ backendId }: { backendId: string }) =>
          `バックエンドを切り替え ${backendId}`,
      },
    },
    details: {
      labels: {
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

  settingsSession: {
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
	    },
	    thinking: {
	      title: "思考",
	      footer:
	        "思考メッセージをセッションのトランスクリプトにどう表示するかを設定します。",
	      displayModeTitle: "思考の表示",
	      displayMode: {
	        inlineTitle: "インライン（デフォルト）",
	        inlineSubtitle:
	          "思考メッセージをトランスクリプトに直接表示します。",
	        toolTitle: "ツールカード",
	        toolSubtitle: "思考メッセージを「推論」ツールカードとして表示します。",
	        hiddenTitle: "非表示",
	        hiddenSubtitle: "思考メッセージをトランスクリプトから非表示にします。",
	      },
	    },
	    toolRendering: {
	      title: "ツール表示",
	      footer:
	        "セッションのタイムラインに表示するツールの詳細量を設定します。これはUI設定であり、エージェントの動作は変わりません。",
	      defaultToolDetailLevelTitle: "デフォルトのツール詳細レベル",
	      expandedToolDetailLevelTitle: "展開時のツール詳細レベル",
	      timelineChrome: {
	        title: "タイムラインのツール表示スタイル",
	        cardsTitle: "カード",
	        cardsSubtitle:
	          "詳細レベルに応じて、ツールカードに内容をインライン表示します。",
	        activityFeedTitle: "アクティビティフィード",
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
	        defaultDetailTitle: "アクティビティフィードの既定詳細",
	        expandedDetailTitle: "アクティビティフィードの展開時詳細",
	        tapActionTitle: "タップ動作（アクティビティフィード）",
	        tapAction: {
	          expandTitle: "展開",
	          expandSubtitle: "タップでインライン詳細を展開/折りたたみします。",
	          openTitle: "開く",
	          openSubtitle: "タップでフルツールビュー画面を開きます。",
	        },
	        defaultExpandedTitle: "既定で展開",
	        defaultExpandedSubtitle:
	          "アクティビティフィードでツール行を既定で展開します。",
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
	      layoutTitle: "レイアウト",
	      layoutFooter:
	        "シンプルな線形トランスクリプトとターン表示を選べます。",
	      layoutPickerTitle: "トランスクリプトレイアウト",
	      layout: {
	        linearTitle: "線形（現在）",
	        linearSubtitle: "メッセージをフラットなリストとして表示します。",
	        turnsTitle: "ターン",
	        turnsSubtitle: "ユーザー/アシスタントのターンにまとめます。",
	      },
	      activityGroupTitle: "ツールをアクティビティにまとめる",
	      activityGroupSubtitle:
	        "各ターン内でツール呼び出しを「アクティビティ」セクションにまとめます。",
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
	      jumpToBottomTitle: "最下部へジャンプボタン",
	      jumpToBottomSubtitle:
	        "上にスクロールしている間に新しいアクティビティが来たら表示します。",
	      advancedScrollTitle: "詳細スクロール…",
	      advancedScrollSubtitle: "しきい値とカウンターを調整します。",
	      advanced: {
	        turnGroupingTitle: "ターンのグルーピング",
	        turnGroupingFooter:
	          "ターン内でアクティビティをどう形成するかを制御します。",
	        activityStrategyTitle: "アクティビティのグルーピング戦略",
	        activityStrategy: {
	          consecutiveTitle: "連続ツール（既定）",
	          consecutiveSubtitle:
	            "連続するツール呼び出しのみをアクティビティにまとめます。",
	          allToolsTitle: "ターン内の全ツール",
	          allToolsSubtitle:
	            "ターン内の全ツール呼び出しを1つのアクティビティにまとめます。",
	        },
            activityCollapsedPreviewCountTitle: "プレビュー（折りたたみ時）",
            activityCollapsedPreviewCountSubtitle: ({ value }: { value: string }) => `アクティビティが折りたたまれているとき、最新の ${value} 件のツールを表示します。`,
            activityCollapsedPreviewCount: {
              offTitle: "オフ",
              offSubtitle: "アクティビティのヘッダーのみ表示します。",
              oneTitle: "1 ツール",
              oneSubtitle: "最新のツールをプレビュー行として表示します。",
              twoTitle: "2 ツール",
              twoSubtitle: "最新 2 件のツールをプレビュー行として表示します。",
              threeTitle: "3 ツール",
              threeSubtitle: "最新 3 件のツールをプレビュー行として表示します。",
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
	      footer:
	        "特定のツールの詳細レベルを上書きします。上書きはレガシー正規化後の正規ツール名（V2）に適用されます。",
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
	    actionsEntry: {
	      footer:
	        "サーフェスと配置（UI、音声、MCP）ごとにアクションを有効化し、表示場所を制御します。",
	      openSubtitle: "アクション設定を開く",
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
	      recentMessagesTitle: "含める最近メッセージ",
	      recentMessagesPlaceholder: "16",
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
          styleDefaultSubtitle: "カード: 要約。アクティビティフィード: コンパクト。",
          expandedStyleDefaultTitle: "デフォルト（推奨）",
          expandedStyleDefaultSubtitle: "カード: 詳細。アクティビティフィード: 要約。",
	    },
	    terminalConnect: {
	      title: "ターミナル接続",
	      legacySecretExportTitle: "旧シークレットのエクスポート（互換）",
	      legacySecretExportEnabledSubtitle:
	        "有効：旧アカウントシークレットをターミナルへエクスポートし、古いターミナルが接続できるようにします。推奨されません。",
	      legacySecretExportDisabledSubtitle:
	        "無効（推奨）：コンテンツキーのみでターミナルをプロビジョニングします（Terminal Connect V2）。",
	    },
    sessionList: {
      title: "セッション一覧",
      footer: "各セッション行に表示する内容をカスタマイズします。",
      tagsTitle: "セッションタグ",
      tagsEnabledSubtitle: "セッション一覧にタグ操作を表示",
      tagsDisabledSubtitle: "タグ操作を非表示",
    },
  },
  settingsVoice: {
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
    ui: {
      title: "音声サーフェス",
      footer: "音声イベントの画面内フィード（セッションには書き込みません）。",
      activityFeedEnabled: "音声アクティビティフィードを有効化",
      activityFeedEnabledSubtitle: "音声利用中に最近の音声イベントを表示",
      activityFeedAutoExpandOnStart: "開始時に自動で展開",
      activityFeedAutoExpandOnStartSubtitle: "音声開始時にフィードを自動で展開します",
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
      speakerBoostTitle: "スピーカーブースト",
      speakerBoostSubtitle: "明瞭さと存在感を改善（任意）。",
      speakerBoostAuto: "自動",
      speakerBoostAutoSubtitle: "ElevenLabs のデフォルトを使用。",
      speakerBoostOn: "オン",
      speakerBoostOnSubtitle: "スピーカーブーストを強制的に有効化。",
      speakerBoostOff: "オフ",
      speakerBoostOffSubtitle: "スピーカーブーストを強制的に無効化。",
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
          style: {
            title: "スタイル",
            subtitle: "0–1。空欄で既定。",
            promptTitle: "スタイル（0–1）",
            promptBody: "0〜1 の数値を入力してください。空欄で既定を使用します。",
            invalid: "0〜1 の数値を入力してください。",
          },
          speed: {
            title: "速度",
            subtitle: "0.5–2。空欄で既定。",
            promptTitle: "速度（0.5–2）",
            promptBody: "0.5〜2 の数値を入力してください。空欄で既定を使用します。",
            invalid: "0.5〜2 の数値を入力してください。",
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
    local: {
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
          enableTtsTitle: "TTS ストリーミングを有効化",
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
    },
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
    linkNewDevice: "新しいデバイスをリンク",
    linkNewDeviceSubtitle: "QRコードをスキャンしてデバイスをリンク",
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
    secretKeyMissing: "Secret key unavailable. Please restore your account first.",
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
    updateAvailable: "アップデートが利用可能",
    pressToApply: "タップしてアップデートを適用",
    whatsNew: "新機能",
    seeLatest: "最新のアップデートと改善を確認",
    nativeUpdateAvailable: "アプリのアップデートが利用可能",
    tapToUpdateAppStore: "タップしてApp Storeで更新",
    tapToUpdatePlayStore: "タップしてPlay Storeで更新",
  },

  changelog: {
    // Used by the changelog screen
    version: ({ version }: { version: number }) => `バージョン ${version}`,
    noEntriesAvailable: "変更履歴はありません。",
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
      "エンドツーエンド暗号化され、アカウントはデバイスにのみ保存されます。",
    createAccount: "アカウントを作成",
    chooseEncryptionTitle: "Choose encryption",
    chooseEncryptionBody: "This server supports both encrypted and non-encrypted accounts. Choose how you want to store your account data.",
    chooseEncryptionEncrypted: "Continue with end-to-end encryption",
    chooseEncryptionPlain: "Continue without encryption",
    signUpWithProvider: ({ provider }: { provider: string }) =>
      `${provider}で続行`,
    signInWithCertificate: "証明書でサインイン",
    linkOrRestoreAccount: "アカウントをリンクまたは復元",
    loginWithMobileApp: "モバイルアプリでログイン",
    serverUnavailableTitle: "サーバーに接続できません",
    serverUnavailableBody: ({ serverUrl }: { serverUrl: string }) =>
      `${serverUrl} に接続できません。再試行するか、サーバーを変更して続行してください。`,
    serverIncompatibleTitle: "サーバーが未対応です",
    serverIncompatibleBody: ({ serverUrl }: { serverUrl: string }) =>
      `${serverUrl} のサーバーから想定外の応答が返されました。サーバーを更新するか、サーバーを変更して続行してください。`,
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
  },

	  machine: {
    launchNewSessionInDirectory: "ディレクトリで新しいセッションを起動",
    offlineUnableToSpawn: "マシンがオフラインのためランチャーは無効です",
    offlineHelp:
      "• コンピューターがオンラインであることを確認してください\n• `happier daemon status`を実行して診断してください\n• 最新のCLIバージョンを使用していますか？`npm install -g @happier-dev/cli@latest`でアップグレードしてください",
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
    },
  },

  message: {
    switchedToMode: ({ mode }: { mode: string }) =>
      `${mode}モードに切り替えました`,
    discarded: "破棄済み",
    unknownEvent: "不明なイベント",
    usageLimitUntil: ({ time }: { time: string }) => `${time}まで使用制限中`,
    unknownTime: "不明な時間",
  },

  chatFooter: {
    permissionsTerminalOnly:
      "権限はターミナルにのみ表示されます。リセットするかメッセージを送信して、アプリから制御してください。",
    sessionRunningLocally:
      "このセッションはこのコンピュータでローカル実行されています。アプリから制御するにはリモートに切り替えられます。",
    switchToRemote: "リモートに切り替え",
    localModeAvailable: "このセッションではローカルモードを利用できます。",
    localModeUnavailableMachineOffline:
      "このマシンがオフラインの間はローカルモードを利用できません。",
    localModeUnavailableDaemonStarted:
      "デーモンによって開始されたセッションではローカルモードを利用できません。",
    localModeUnavailableNeedsResume:
      "ローカルモードには、このプロバイダーの再開サポートが必要です。",
    switchToLocal: "ローカルに切り替え",
  },

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
      yesForCommandName: "はい、このコマンドについては確認しない",
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
    noData: "使用データがありません",
  },

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
} as const;
