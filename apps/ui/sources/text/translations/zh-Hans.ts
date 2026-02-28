/**
 * Chinese (Simplified) translations for the Happier app
 * Values can be:
 * - String constants for static text
 * - Functions with typed object parameters for dynamic text
 */

import type { TranslationStructure } from "../_types";

/**
 * Chinese plural helper function
 * @param options - Object containing count, singular, and plural forms
 * @returns The appropriate form based on count
 */
function plural({
  count,
  singular,
  plural,
}: {
  count: number;
  singular: string;
  plural: string;
}): string {
  return count === 1 ? singular : plural;
}

export const zhHans: TranslationStructure = {
  tabs: {
    // Tab navigation labels
    inbox: "好友",
    sessions: "终端",
    settings: "设置",
  },

  inbox: {
    // Inbox screen
    emptyTitle: "暂无好友动态",
    emptyDescription: "添加好友以共享会话，并在这里查看动态。",
    updates: "动态",
  },

  runs: {
    title: "运行",
    empty: "暂无运行记录。",
    groupLabel: ({ groupId }: { groupId: string }) => `组 ${groupId}`,
    showFinished: "显示已完成",
    unknownMachine: "未知机器",
    failedToLoad: "加载运行失败",
    noMachinesAvailable: "没有可用的机器。",
    serverTitle: ({ serverId }: { serverId: string }) => `服务器 ${serverId}`,
    machinesSubtitle: "机器",
    openMachine: "打开机器",
    a11y: {
      toggleFinished: "切换已完成运行",
      refresh: "刷新运行",
    },
    openSession: "打开会话",
    sessionTitle: ({ sessionId }: { sessionId: string }) => `会话 ${sessionId}`,
    runLabel: ({ runId }: { runId: string }) => `运行 ${runId}`,
    detail: {
      pid: ({ pid }: { pid: number }) => `PID ${pid}`,
      cpu: ({ percent }: { percent: string }) => `${percent}% CPU`,
      memory: ({ megabytes }: { megabytes: number }) => `${megabytes} MB`,
    },
    runDetails: {
      failedToLoad: "加载运行失败",
      latestToolResultTitle: "最新工具结果",
      a11y: {
        refreshRun: "刷新运行",
      },
    },
    stop: {
      stopRunA11y: "停止运行",
      stopLabel: "停止运行",
      stoppingLabel: "正在停止…",
      stopRunFailedTitle: "停止运行失败",
      stopRunFailedBody:
        "通过会话 RPC 停止该运行失败。是否改为停止整个会话进程？这将执行破坏性操作，并停止该会话中的所有运行。",
      stopSession: "停止会话",
      failedToStopRun: "无法停止运行",
      failedToStopSession: "无法停止会话",
    },
    send: {
      placeholder: "发送到运行…",
      a11y: {
        sendToRun: "发送到运行",
      },
      sendLabel: "发送",
      sendingLabel: "正在发送…",
      failedToSend: "发送失败",
    },
  },

  sessionLog: {
    title: "会话日志",
    devModeRequiredTitle: "需要开发者模式",
    devModeRequiredBody: "要查看会话日志，请在设置中启用开发者模式。",
    logPathTitle: "日志路径",
    unavailable: "不可用",
    logPathCopyLabel: "会话日志路径",
    refreshTailTitle: "刷新日志尾部",
    refreshTailSubtitle: ({ maxBytes }: { maxBytes: string }) =>
      `读取最后 ${maxBytes} 字节`,
    copyVisibleTitle: "复制可见日志",
    copyVisibleSubtitleLoaded: "将当前尾部复制到剪贴板",
    copyVisibleSubtitleEmpty: "未加载日志内容",
    copyLogLabel: "会话日志",
    statusTitle: "日志状态",
    readErrorTitle: "读取错误",
    tailTitle: "日志尾部",
    tailTitleTruncated: "日志尾部（已截断）",
    noOutputYet: "（暂无日志输出）",
    readFailed: "读取会话日志失败",
  },

  automations: {
    openA11y: "打开自动化",
    gate: {
      disabledTitle: "自动化已禁用",
      disabledBody: "请在设置中启用，然后开启实验功能与自动化。",
    },
    edit: {
      title: "编辑自动化",
      saveAutomationLabel: "保存自动化",
      messageLabel: "消息",
      messagePlaceholder: "要发送的消息",
      messageHelpText: "该消息将作为待发送的用户消息排入会话队列。",
      updateFailed: "更新自动化失败。",
      loadTemplateFailed: "加载自动化模板失败。",
    },
    form: {
      groupAutomationTitle: "自动化",
      groupScheduleTitle: "计划",
      toggleEnableTitle: "启用自动化",
      toggleEnableSubtitle:
        "将此新会话模板创建为计划自动化，而不是立即开始。",
      toggleEnabledTitle: "已启用",
      toggleEnabledSubtitle: "禁用后，将不会执行任何计划运行。",
      labels: {
        name: "名称",
        descriptionOptional: "描述（可选）",
        everyMinutes: "每隔（分钟）",
        cronExpression: "CRON 表达式",
        timezoneOptional: "时区（可选）",
      },
      placeholders: {
        name: "计划会话",
        description: "这个自动化应该做什么？",
        everyMinutes: "60",
        cronExpression: "*/5 * * * *",
        timezone: "UTC 或 America/New_York",
      },
      schedule: {
        intervalTitle: "间隔",
        intervalSubtitle: "每 N 分钟运行一次。",
        cronTitle: "Cron 表达式",
        cronSubtitle: "高级计划表达式。",
        cronHelpText: "标准 5 段 cron：分钟 小时 月日 月 星期。",
      },
    },
    session: {
      emptyTitle: "暂无自动化",
      emptyBody: "添加一个自动化，将计划消息排入此会话队列。",
      addAutomation: "添加自动化",
      failedToLoad: "加载自动化失败。",
    },
    screen: {
      emptyTitle: "暂无自动化",
      emptyBody: "可在“新建会话”流程中创建，以在机器上运行计划会话。",
      createAutomationA11y: "创建自动化",
    },
    detail: {
      invalidId: "无效的自动化 ID。",
      notFound: "未找到自动化。",
      unknownDate: "未知",
      notScheduled: "未计划",
      overviewGroupTitle: "概览",
      overview: {
        nameTitle: "名称",
        scheduleTitle: "计划",
        statusTitle: "状态",
        nextRunTitle: "下次运行",
      },
      status: {
        active: "启用",
        paused: "已暂停",
      },
      actionsGroupTitle: "操作",
      runNowTitle: "立即运行",
      runNowQueuedBadge: "已排队",
      runNowQueuedLine: "已排队。",
      runNowQueuedSubtitle: "已排队。分配的守护进程将在可用时执行。",
      pauseAutomation: "暂停自动化",
      resumeAutomation: "恢复自动化",
      editAutomation: "编辑自动化",
      deleteAutomation: "删除自动化",
      deleteConfirmTitle: "删除自动化",
      deleteConfirmMessage: "此自动化及其计划将被移除。",
      deleteConfirmButton: "删除",
      machineAssignmentsTitle: "机器分配",
      machineAssignmentsFooter: "至少启用一台机器，自动化才能运行。",
      refreshFailed: "刷新自动化失败。",
      runFailed: "运行自动化失败。",
      deleteFailed: "删除自动化失败。",
      assignmentsUpdateFailed: "更新机器分配失败。",
      recentRunsTitle: "最近运行",
      runMeta: {
        scheduled: ({ time }: { time: string }) => `计划：${time}`,
        updated: ({ time }: { time: string }) => `更新：${time}`,
        error: ({ message }: { message: string }) => `错误：${message}`,
      },
    },
    create: {
      defaultName: "定时消息",
      createFailed: "创建自动化失败。",
      unavailableGroupTitle: "不可用",
      cannotCreateForSession: "无法为此会话创建自动化",
      sessionNotFound: "未找到会话。",
      missingMachineId: "此会话缺少机器 ID。",
      missingResumeKey: "此会话尚未加载用于恢复的加密密钥。",
      createButtonTitle: "创建自动化",
    },
  },

  appCrash: {
    title: "出错了",
    subtitle: "Happier 发生了意外错误。你可以重启应用界面，或复制详细信息以便支持排查。",
    detailsTitle: "错误详情",
    restart: "重启应用",
    copyDetails: "复制错误详情",
  },

  webCryptoGate: {
    title: "需要安全连接",
    subtitle:
      "此页面需要 WebCrypto 来保护你的数据。由于浏览器要求安全上下文（如 HTTPS/localhost），此来源无法使用 WebCrypto。",
    howToFix: "如何解决",
    fixHttps: "通过 HTTPS 打开 UI（推荐）。",
    fixTunnel: "如需在局域网访问，请使用 HTTPS 隧道或带 TLS 的反向代理。",
    fixLocalhost: "如果在同一台机器上访问，请使用 http://localhost（回环地址会被视为安全）。",
    currentOrigin: "当前来源",
    secureContext: "安全上下文",
    copyDetails: "复制详情",
    reload: "刷新",
  },

  common: {
    // Simple string constants
    add: "添加",
    edit: "编辑",
    actions: "操作",
    moreActions: "更多操作",
    moreActionsHint: "打开包含更多操作的菜单",
    cancel: "取消",
    close: "关闭",
    open: "打开",
    authenticate: "认证",
    save: "保存",
    saveAs: "另存为",
    error: "错误",
    success: "成功",
    ok: "确定",
    continue: "继续",
    back: "返回",
    start: "开始",
    create: "创建",
    rename: "重命名",
    remove: "移除",
    update: "更新",
    commit: "提交",
    history: "历史",
      applied: "已应用",
      signOut: "退出登录",
      keep: "保留",
      use: "使用",
      reset: "重置",
      logout: "登出",
      yes: "是",
      no: "否",
    on: "开启",
    off: "关闭",
    discard: "放弃",
    discardChanges: "放弃更改",
    unsavedChangesWarning: "你有未保存的更改。",
    keepEditing: "继续编辑",
    version: "版本",
    details: "详情",
    copied: "已复制",
    copy: "复制",
    copyWithLabel: ({ label }: { label: string }) => `复制 ${label}`,
    expand: "展开",
    collapse: "收起",
    command: "命令",
    scanning: "扫描中...",
    urlPlaceholder: "https://example.com",
    home: "主页",
    message: "消息",
    send: "发送",
    attach: "附加",
    linkFile: "链接文件",
    files: "文件",
    path: "路径",
    fileViewer: "文件查看器",
    loading: "加载中...",
    retry: "重试",
    or: "或",
    delete: "删除",
    deleted: "已删除",
    optional: "可选的",
    noMatches: "无匹配结果",
    all: "全部",
    machine: "机器",
    clearSearch: "清除搜索",
    refresh: "刷新",
    default: "默认",
    enabled: "已启用",
    disabled: "已禁用",
    done: "完成",
    reorder: "重新排序",
    none: "—",
    unavailable: "不可用",
    dialog: "对话框",
    requestFailed: "请求失败。",
  },

  ui: {
    resizableDockedPane: {
      resizeA11y: "调整面板大小",
      resizeHint: "使用左右方向键调整大小",
    },
  },

  dropdown: {
    category: {
      general: "常规",
      results: "结果",
    },
    createItem: {
      prefix: "添加",
    },
  },

  profile: {
    userProfile: "用户资料",
    details: "详情",
    firstName: "名",
    lastName: "姓",
    username: "用户名",
    status: "状态",
  },

  status: {
    connected: "已连接",
    connecting: "连接中",
    disconnected: "已断开",
    error: "错误",
    online: "在线",
    offline: "离线",
    lastSeen: ({ time }: { time: string }) => `最后活跃时间 ${time}`,
    actionRequired: "需要操作",
    permissionRequired: "需要权限",
    activeNow: "当前活跃",
    unknown: "未知",
  },

  connectionStatus: {
    title: "连接",
    labels: {
      server: "服务器",
      socket: "套接字",
      authenticated: "已认证",
      lastSync: "上次同步",
      nextRetry: "下次重试",
      lastError: "上次错误",
    },
  },

  time: {
    justNow: "刚刚",
    minutesAgo: ({ count }: { count: number }) => `${count} 分钟前`,
    hoursAgo: ({ count }: { count: number }) => `${count} 小时前`,
  },

  connect: {
    restoreAccount: "恢复账户",
    enterSecretKey: "请输入密钥",
    invalidSecretKey: "无效的密钥，请检查后重试。",
    enterUrlManually: "手动输入 URL",
    scanComputerQrUnavailableTitle: "无法扫描电脑端二维码",
    scanComputerQrUnavailableBody:
      "此服务器已禁用该登录方式。请使用下方的其他选项恢复你的账号。",
    scanComputerQrInstructions: "扫描电脑端 Happier（设置 → 添加手机）中显示的二维码。",
    scanComputerQrButton: "扫描二维码登录",
    waitingForApproval: "等待确认…",
    showQrInstead: "改为显示二维码",
    addPhoneQrInstructions: "用 Happier 手机应用扫描此二维码，在手机上登录。",
    pairingRequestTitle: "配对请求",
    pairingRequestBody: "确认该验证码与手机上显示的一致，然后批准。",
    pairingAlreadyRequestedTitle: "二维码已被使用",
    pairingAlreadyRequestedBody:
      "此二维码已在另一部手机上扫描。请在电脑上生成新的二维码。",
    deviceLabel: "设备",
    confirmCodeLabel: "确认码",
    approveButton: "批准",
    generateNewQrCode: "生成新的二维码",
    pairingQrExpired: "此二维码已过期。请生成新的二维码。",
    openMachine: "打开机器",
    terminalUrlPlaceholder: "happier://terminal?...",
    accountUrlPlaceholder: "happier:///account?...",
    restoreQrInstructions: "在已登录的设备上前往 设置 → 账户 并扫描此二维码。",
    externalAuthVerifiedTitle: ({ provider }: { provider: string }) =>
      `${provider} 验证完成`,
    externalAuthVerifiedBody: ({ provider }: { provider: string }) =>
      `我们找到了与 ${provider} 关联的现有 Happier 账户。要在此设备上完成登录，请使用二维码或你的密钥恢复账户密钥。`,
    restoreWithSecretKeyInstead: "改用密钥恢复",
    restoreWithSecretKeyDescription: "输入你的密钥以恢复账户访问权限。",
    lostAccessLink: "无法访问？",
    lostAccessTitle: "无法访问你的账户？",
    lostAccessBody:
      "如果你已没有任何设备与此账户关联，并且丢失了密钥，你可以通过身份提供方重置账户。这将创建一个新的 Happier 账户。旧的加密历史无法恢复。",
    lostAccessContinue: ({ provider }: { provider: string }) =>
      `使用 ${provider} 继续`,
    lostAccessConfirmTitle: "重置账户？",
    lostAccessConfirmBody:
      "这将创建一个新账户并重新绑定你的身份。旧的加密历史无法恢复。",
    lostAccessConfirmButton: "重置并继续",
    secretKeyPlaceholder: "XXXXX-XXXXX-XXXXX...",
    linkNewDeviceTitle: "链接新设备",
    linkNewDeviceSubtitle: "扫描新设备上显示的二维码以将其链接到此账户",
    linkNewDeviceQrInstructions: "在新设备上打开 Happier 并显示二维码",
    scanQrCodeOnDevice: "扫描二维码",
    unsupported: {
      connectTitle: ({ name }: { name: string }) => `连接 ${name}`,
      runCommandInTerminal: "在终端中运行以下命令：",
      runCommandInTerminalWithCommand: ({ command }: { command: string }) =>
        `在终端中运行以下命令：\n\n${command}`,
      command: ({ name }: { name: string }) => `happier connect ${name}`,
    },
  },

  bugReports: {
    composer: {
      alerts: {
        previewUnavailableTitle: "无法预览",
        previewUnavailableBody: "无法构建诊断预览。",
        submittedTitle: "Bug 报告已提交",
        submittedExistingIssueBody: ({ issueNumber, reportId }: { issueNumber: number; reportId: string }) =>
          `已在 issue #${issueNumber} 发布评论。\n\n报告 ID: ${reportId}`,
        submittedNewIssueBody: ({ issueNumber, reportId }: { issueNumber: number; reportId: string }) =>
          `已创建 issue #${issueNumber}。\n\n报告 ID: ${reportId}`,
        submitFailedTitle: "提交失败",
        submitFailedFallbackMessage: "无法提交此报告。",
        submitFailedBody: ({ message }: { message: string }) =>
          `${message}\n\n是否改为打开一个预填的 GitHub issue？`,
        openFallbackIssueButton: "打开备用 issue",
      },
      diagnostics: {
        title: "诊断",
        subtitle: "选择要包含的内容，并在提交前预览。",
        includeTitle: "包含诊断",
        includeSubtitle: "附加已脱敏的调试资料，以加快定位。",
        disabledByServerSuffix: "（服务器已禁用）",
        pasteDoctorJson: {
          title: "CLI doctor JSON（可选）",
          subtitle:
            "如果 UI 无法访问你的机器，请在电脑上运行 `happier doctor --json` 并粘贴到这里。",
          placeholder: '{ "capturedAt": "...", ... }',
          invalid: ({ error }: { error: string }) => `doctor JSON 无效：${error}`,
          valid: "doctor JSON 看起来有效，将随报告一起提交。",
        },
        previewButton: "预览诊断",
        preview: {
          title: "诊断预览",
          helper:
            "这些工件将随报告一起上传（已脱敏并限制大小）。点按项目以查看完整内容。",
          empty: "不会发送任何诊断工件。",
          openArtifactA11y: ({ filename }: { filename: string }) =>
            `打开 ${filename}`,
        },
        kinds: {
          app: {
            title: "应用诊断",
            detail: "应用控制台日志、最近的用户操作以及会话摘要。",
          },
          daemon: {
            title: "守护进程诊断",
            detail: "守护进程摘要以及所选机器上的最近守护进程日志。",
          },
          stackService: {
            title: "Stack 服务诊断",
            detail: "Stack 上下文与最近的 Stack 日志（如可用）。",
          },
          server: {
            title: "服务器诊断",
            detail: "当前活动服务器的快照。",
          },
        },
      },
      issueDetails: {
        title: "描述问题",
        subtitle: "请提供足够细节，方便我们快速复现并诊断。",
        titleLabel: "标题（必填）",
        titlePlaceholder: "简短的问题标题",
        githubUsernameLabel: "GitHub 用户名（可选）",
        githubUsernamePlaceholder: "将在 issue 正文中作为联系方式使用",
        summaryLabel: "简要概述（必填）",
        summaryPlaceholder: "一段话概述",
        currentBehaviorLabel: "当前行为（可选）",
        currentBehaviorPlaceholder: "实际发生了什么？",
        expectedBehaviorLabel: "期望行为（可选）",
        expectedBehaviorPlaceholder: "应该发生什么？",
        reproductionStepsLabel: "复现步骤（可选）",
        reproductionStepsPlaceholder: "1. 打开 Happier\n2. 开始一个会话\n3. ...",
        whatChangedLabel: "最近有什么变化（可选）",
        whatChangedPlaceholder: "更新、配置变更、新的设置步骤……",
      },
      similarIssues: {
        title: "可能的重复问题",
        subtitle:
          "如果其中某个问题与你的情况相符，你可以把报告作为评论发布，而不是新开一个 issue。",
        searching: "正在搜索 issue…",
        selectedTitle: ({ number }: { number: number }) => `使用 issue #${number}`,
        selectedSubtitle: "点击以切换回创建新 issue。",
        useIssueA11y: ({ number }: { number: number }) => `使用 issue #${number}`,
        issueState: {
          open: "未关闭",
          closed: "已关闭",
        },
      },
      frequencySeverity: {
        title: "频率与严重程度",
        frequencyLabel: "频率",
        severityLabel: "严重程度",
        frequency: {
          always: "总是",
          often: "经常",
          sometimes: "有时",
          once: "一次",
        },
        severity: {
          blocker: "阻断",
          high: "高",
          medium: "中",
          low: "低",
        },
      },
      environment: {
        title: "环境（可编辑）",
        appVersionLabel: "应用版本",
        platformLabel: "平台",
        osVersionLabel: "系统版本",
        deviceModelLabel: "设备型号",
        serverUrlLabel: "服务器 URL",
        serverVersionLabel: "服务器版本（可选）",
        deploymentTypeLabel: "部署类型",
        deploymentType: {
          cloud: "云端",
          selfHosted: "自托管",
          enterprise: "企业",
        },
      },
      consent: {
        title: "确认",
        understandTitle: "我理解诊断可能包含技术元数据",
        understandSubtitle: "请勿包含密码、访问令牌或私钥。",
      },
      submit: {
        requiredFieldsHint: "填写必填项后才能提交。",
        submitting: "正在提交…",
        addToIssue: ({ number }: { number: number }) => `添加到 issue #${number}`,
        submitNew: "提交 Bug 报告",
      },
    },
  },

  memorySearchSettings: {
    disabled: {
      footer: "在“功能”中启用记忆搜索以配置本地索引。",
      title: "记忆搜索已禁用",
      subtitle: "打开 设置 → 功能 以启用 memory.search",
      openFeatureSettings: "打开功能设置",
      alertTitle: "记忆搜索已禁用",
      alertBody: "在 设置 → 功能 中启用 memory.search。",
    },
    enabled: {
      title: "已启用",
      subtitle: "在此设备上构建并维护本地索引",
      footer:
        "启用后，Happier 会基于已解密的对话记录在设备本地构建索引，以支持快速回忆与搜索。",
    },
    budgets: {
      groupTitle: "磁盘配额",
      groupFooter: "限制本地记忆索引可使用的磁盘空间（尽力而为地回收）。",
      mbLabel: ({ mb }: { mb: number }) => `${mb} MB`,
      lightTitle: "轻量索引配额",
      lightPromptTitle: "轻量索引配额",
      lightPromptBody: "此设备上轻量（摘要分片）索引的最大 MB。",
      deepTitle: "深度索引配额",
      deepPromptTitle: "深度索引配额",
      deepPromptBody: "此设备上深度（分块）索引的最大 MB。",
    },
    privacy: {
      groupTitle: "隐私",
      groupFooter: "在禁用记忆搜索时删除本地派生索引和模型缓存。",
      deleteOnDisableTitle: "禁用时删除",
      deleteOnDisableSubtitle: "关闭记忆搜索时移除本地索引和缓存",
    },
    screen: {
      machineLabel: ({ machine }: { machine: string }) => `机器：${machine}`,
      searchPlaceholder: "搜索记忆",
      enableLocalSearch: "启用本地记忆搜索",
    },
    machine: {
      title: "设备",
      changeTitle: "更换设备",
      noMachine: "无设备",
    },
    indexMode: {
      title: "索引模式",
      footer:
        "轻量模式只存储较小的摘要分片。深度模式更全面，但占用更多磁盘。",
      triggerTitle: "模式",
      options: {
        lightTitle: "轻量（推荐）",
        lightSubtitle: "仅摘要分片",
        deepTitle: "深度",
        deepSubtitle: "在本地索引消息分片",
      },
    },
    backfill: {
      title: "回填",
      footer: "控制启用本地记忆时要索引多少历史记录。",
      triggerTitle: "策略",
      options: {
        newOnlyTitle: "仅新内容（推荐）",
        newOnlySubtitle: "仅索引启用之后创建的内容",
        last30DaysTitle: "最近30天",
        last30DaysSubtitle: "回填最近的会话",
        allHistoryTitle: "全部历史",
        allHistorySubtitle: "回填全部（可能需要时间）",
      },
    },
    hints: {
      title: "记忆提示生成",
      footer: "控制轻量记忆搜索的摘要分片生成方式。",
      backend: {
        title: "摘要后端",
        promptTitle: "摘要后端",
        promptBody: "输入一个 execution-run 后端 id（例如：claude、codex）。",
      },
      model: {
        title: "摘要模型",
        promptTitle: "摘要模型",
        promptBody: "输入要传递给后端的模型 id。",
      },
      permissions: {
        triggerTitle: "摘要权限",
        options: {
          noToolsTitle: "无工具（推荐）",
          noToolsSubtitle: "仅总结文本",
          readOnlyTitle: "只读",
          readOnlySubtitle: "在支持时允许不改变状态的工具",
        },
      },
    },
    embeddings: {
      groupTitle: "嵌入",
      groupFooter:
        "可选：下载本地模型，以在使用深度模式时提升语义匹配效果。",
      enableTitle: "启用嵌入",
      enableSubtitle: "提升深度搜索的排序效果（首次使用时会下载模型）",
      modelTitle: "嵌入模型",
      promptBody: "输入本地 transformers 模型 id。",
      modelPlaceholder: "Xenova/all-MiniLM-L6-v2",
    },
  },

  subAgentGuidance: {
    ruleEditor: {
      header: {
        newRule: "新规则",
        editRule: "编辑规则",
      },
      enabled: {
        title: "启用",
      },
      enabledState: {
        enabled: "已启用",
        disabled: "已禁用",
      },
      common: {
        noPreference: "无偏好",
      },
      titleField: {
        label: "标题（可选）",
        placeholder: "例如：UI 工作",
      },
      descriptionField: {
        label: "何时应让代理进行委派？",
        placeholder: "描述何时/如何委派…",
      },
      backendPicker: {
        title: "目标后端（可选）",
        searchPlaceholder: "搜索后端",
        noPreference: {
          subtitle: "让代理选择后端。",
        },
      },
      modelPicker: {
        title: "目标模型（可选）",
        searchPlaceholder: "搜索模型",
        noPreference: {
          subtitle: "让后端选择默认模型。",
        },
      },
      intent: {
        title: "建议意图（可选）",
        noPreference: {
          subtitle: "让代理决定意图。",
        },
        options: {
          review: {
            title: "审查",
            subtitle: "代码审查 / 发现。",
          },
          plan: {
            title: "规划",
            subtitle: "规划 / 架构。",
          },
          delegate: {
            title: "委派",
            subtitle: "委派 / 执行。",
          },
        },
      },
      exampleToolCalls: {
        label: "示例工具调用（可选，每行一个）",
        placeholder: "例如：execution.run.start …",
      },
    },
    settings: {
      groupTitle: "子代理",
      disabled: {
        footer:
          "Execution runs 已禁用。请在 设置 → 功能 中启用 Execution Runs 以使用委派指引。",
        enableExecutionRuns: {
          title: "启用 Execution Runs",
          subtitle: "打开功能设置",
        },
      },
      footer:
        "规则会追加到系统提示词中，让主代理知道你希望何时以及如何启动子代理运行。",
      enableInjection: {
        title: "启用指引注入",
      },
      characterBudget: {
        title: "字符上限",
        subtitle: ({ value }: { value: string }) => `${value} 个字符`,
        promptTitle: "字符上限",
        promptBody: "注入到系统提示词中的最大字符数。",
      },
      rules: {
        groupTitle: "指引规则",
        footerEnabled: "点击规则以编辑。代理会将其作为委派提示。",
        footerDisabled: "启用注入以激活规则。",
        emptyTitle: "还没有规则",
        emptySubtitle: "添加规则以指导委派。",
        addRuleTitle: "添加规则",
        addRuleSubtitle: "创建新的指引规则",
        untitled: "未命名规则",
        descriptionFallback: "描述何时委派。",
        tapToEdit: "点击编辑",
        meta: {
          target: ({ value }: { value: string }) => `目标：${value}`,
          model: ({ value }: { value: string }) => `模型：${value}`,
          intent: ({ value }: { value: string }) => `意图：${value}`,
        },
      },
      preview: {
        title: "预览",
        footer: "这是追加到系统提示词中的（截断后的）文本。",
        systemPromptLabel: "系统提示词（已追加）",
      },
    },
  },

  settings: {
    title: "设置",
    connectedAccounts: "已连接账户",
    connectedAccountsDisabled: "已禁用已连接的服务。",
    connectAccount: "连接账户",
    github: "GitHub",
    machines: "设备",
    features: "功能",
    social: "社交",
    account: "账户",
    accountSubtitle: "管理您的账户详情",
    addYourPhone: "添加手机",
    addYourPhoneSubtitle: "显示二维码以便在手机上登录",
    appearance: "外观",
    appearanceSubtitle: "自定义应用外观",
    voiceAssistant: "语音助手",
    voiceAssistantSubtitle: "配置语音交互偏好",
    memorySearch: "本地记忆搜索",
    memorySearchSubtitle: "在设备本地搜索过往对话",
    notifications: "通知",
    notificationsSubtitle: "推送通知偏好设置",
    attachments: "附件",
    attachmentsSubtitle: "文件上传偏好设置",
    sourceControl: "版本控制",
    sourceControlSubtitle: "提交策略与后端行为",
    automations: "自动化",
    automationsSubtitle: "管理定时会话与周期性运行",
    executionRunsSubtitle: "跨设备执行运行",
    connectedServices: "已连接服务",
    connectedServicesSubtitle: "Claude/Codex 订阅与 OAuth 配置",
    featuresTitle: "功能",
    featuresSubtitle: "启用或禁用应用功能",
    developer: "开发者",
    developerTools: "开发者工具",
    about: "关于",
    actionsSettingsAboutSubtitle:
      "可全局、按界面（UI/语音/MCP）以及按展示位置（在界面中出现的位置）启用或禁用操作。被禁用的操作在运行时会以安全方式（fail-closed）被阻止。",
    aboutFooter:
      "Happier Coder 是一个 Codex 和 Claude Code 移动客户端。它采用端到端加密，您的账户仅存储在本地设备上。与 Anthropic 无关联。",
    whatsNew: "更新日志",
    whatsNewSubtitle: "查看最新更新和改进",
    reportIssue: "报告问题",
    privacyPolicy: "隐私政策",
    termsOfService: "服务条款",
    eula: "最终用户许可协议",
    supportUs: "支持我们",
    supportUsSubtitlePro: "感谢您的支持！",
    supportUsSubtitle: "支持项目开发",
    scanQrCodeToAuthenticate: "扫描二维码连接终端",
    githubConnected: ({ login }: { login: string }) => `已连接为 @${login}`,
    connectGithubAccount: "连接您的 GitHub 账户",
    claudeAuthSuccess: "成功连接到 Claude",
    exchangingTokens: "正在交换令牌...",
    usage: "使用情况",
    usageSubtitle: "查看 API 使用情况和费用",
    profiles: "配置文件",
    profilesSubtitle: "管理环境配置文件和变量",
    secrets: "机密",
    secretsSubtitle: "管理已保存的机密（输入后将不再显示）",
    terminal: "终端",
    session: "会话",
    sessionSubtitleTmuxEnabled: "已启用 Tmux",
    sessionSubtitleMessageSendingAndTmux: "消息发送与 tmux",
    servers: "服务器",
    serversSubtitle: "已保存的服务器、分组和默认设置",
    systemStatus: "系统状态",
    systemStatusSubtitle: "服务器、账号、机器、守护进程",

    // Dynamic settings messages
    accountConnected: ({ service }: { service: string }) =>
      `已连接 ${service} 账户`,
    machineStatus: ({
      name,
      status,
    }: {
      name: string;
      status: "online" | "offline";
    }) => `${name} ${status === "online" ? "在线" : "离线"}`,
  featureToggled: ({
      feature,
      enabled,
    }: {
      feature: string;
      enabled: boolean;
    }) => `${feature} 已${enabled ? "启用" : "禁用"}`,
  },

  systemStatus: {
    sections: {
      appHealth: "应用与同步状态",
      currentServer: "当前服务器",
      identity: "已登录身份",
      configuredServers: "已配置服务器",
      machinesActiveServer: "机器（当前服务器）",
      machinesOtherServer: ({ server }: { server: string }) => `机器（${server}）`,
      actions: "操作",
    },
    ui: {
      dataReady: "数据就绪",
      realtime: "实时",
      socket: "套接字",
      socketLastError: ({ error }: { error: string }) => `最近错误：${error}`,
      lastSync: "最近同步",
    },
    server: {
      activeServer: "当前服务器",
    },
    identity: {
      accountId: "账号 ID",
      username: "用户名",
    },
    servers: {
      noneConfigured: "未配置服务器",
      active: "当前",
    },
    machines: {
      none: "暂无机器",
      status: ({ status }: { status: string }) => `状态：${status}`,
    },
    machine: {
      unknownHost: "未知机器",
      online: "在线",
      offline: "离线",
      fetchDoctorSnapshot: {
        loading: "正在获取守护进程的服务器/账号…",
        invalid: "无法从机器读取 doctor snapshot",
      },
      daemonAttributionUnknown: "守护进程服务器/账号：未知",
      daemonAttribution: ({ serverUrl, accountId }: { serverUrl: string; accountId: string }) =>
        `守护进程：${serverUrl} • ${accountId}`,
      daemonAttributionAge: ({ age }: { age: string }) => `最近检查：${age}`,
      cliVersionBullet: ({ version }: { version: string }) => ` • v${version}`,
    },
    mismatch: "不匹配",
    time: {
      secondsAgo: ({ count }: { count: number }) => `${count} 秒前`,
      minutesAgo: ({ count }: { count: number }) => `${count} 分钟前`,
      hoursAgo: ({ count }: { count: number }) => `${count} 小时前`,
      daysAgo: ({ count }: { count: number }) => `${count} 天前`,
    },
    actions: {
      runDiagnosis: "运行诊断",
      runDiagnosisSubtitle: "检测服务器/账号/守护进程不匹配",
      refreshMachineAttribution: "刷新守护进程归属信息",
      refreshMachineAttributionSubtitle: "为部分在线机器获取守护进程服务器/账号",
      copyJson: "复制系统状态 JSON",
      copyJsonSubtitle: "复制一个已脱敏的快照用于支持",
    },
  },

  diagnosis: {
    title: "诊断",
    sections: {
      overview: "概览",
      actions: "操作",
      pasteDoctorJson: "粘贴 CLI doctor JSON",
      machineRuns: "机器运行情况",
      serverProbe: "服务器探测",
      findings: "发现的问题",
    },
    overview: {
      activeServer: "当前服务器",
      account: "账号",
      onlineMachines: "在线机器（当前服务器）",
      cachedAttribution: ({ count }: { count: number }) => `可用缓存 doctor snapshot：${count} 个`,
    },
    actions: {
      run: "运行诊断",
      runSubtitle: "检查服务器、账号、机器与守护进程目标",
      copyReport: "复制诊断报告",
      copyReportSubtitle: "复制已脱敏的 JSON 报告用于支持",
    },
    pasteDoctorJson: {
      footer: "提示：在电脑上运行 `happier doctor --json` 并粘贴到这里。",
      placeholder: '{ "capturedAt": "...", ... }',
      parse: "验证粘贴的 JSON",
      ok: "粘贴的 doctor JSON 看起来有效。",
      helper: "可选：当机器不可达时，粘贴 doctor JSON 来诊断账号/服务器不匹配。",
      error: ({ error }: { error: string }) => `doctor JSON 无效：${error}`,
    },
    machine: {
      invalidDoctorSnapshot: "机器返回了无效的 doctor snapshot",
    },
    machineRuns: {
      none: "没有可用的在线机器",
      idle: "空闲",
      loading: "运行中…",
      ready: "完成",
      error: "错误",
    },
    serverProbe: {
      title: "服务器诊断",
      httpError: ({ status }: { status: string }) => `HTTP ${status}`,
    },
    findings: {
      notRun: "运行诊断以查看结果",
      notRunSubtitle: "此处只进行安全的脱敏检查（除非你在 Bug 报告中包含诊断，否则不会上传日志）。",
      none: "未发现问题",
      noneSubtitle: "如问题仍然存在，请提交包含诊断的 Bug 报告。",
      code: ({ code }: { code: string }) => `代码：${code}`,
      generic: {
        subtitle: ({ code }: { code: string }) => `关于 ${code} 的详情`,
        steps: {
          reportIssue: "提交 Bug 报告并附上此诊断报告。",
        },
      },
      serverMismatch: {
        title: "服务器不匹配（UI vs 守护进程）",
        subtitle: ({ ui, machine }: { ui: string; machine: string }) => `UI：${ui} • 守护进程：${machine}`,
        steps: {
          chooseAccount: "确认你希望使用的服务器/账号。",
          switchUiServer: "将 UI 与守护进程切换到同一服务器（或反之）。",
          restartDaemon: "让守护进程指向正确服务器后重启，并重试。",
        },
      },
      serverMismatchPasted: {
        title: "服务器不匹配（UI vs 粘贴的 doctor）",
        subtitle: ({ ui, pasted }: { ui: string; pasted: string }) => `UI：${ui} • 粘贴：${pasted}`,
      },
      settingsMismatch: {
        title: "CLI 设置与解析到的服务器不一致",
        subtitle: ({ settings, resolved }: { settings: string; resolved: string }) => `settings.json：${settings} • 解析：${resolved}`,
      },
      accountMismatch: {
        title: "账号不匹配（UI vs 守护进程）",
        subtitle: ({ ui, machine }: { ui: string; machine: string }) => `UI：${ui} • 守护进程：${machine}`,
        steps: {
          signInSameAccount: "确保 UI 与 CLI 在同一服务器上登录同一账号。",
          cliReauth: "在 CLI 中退出并在正确服务器上重新登录。",
        },
      },
      machineMissingAccount: {
        title: "机器缺少账号信息",
      },
      noOnlineMachines: {
        title: "没有在线机器",
        steps: {
          startDaemon: "启动守护进程（并确保持续运行）。",
          checkNetwork: "检查网络连接并重试。",
        },
      },
      serverDiagnosticsDisabled: {
        title: "服务器诊断已禁用",
        steps: {
          ok: "如果你的服务器禁用了诊断，这是正常现象。",
        },
      },
      serverAuthError: {
        title: "服务器认证错误（401）",
      },
      serverUnreachable: {
        title: "无法访问服务器",
        steps: {
          checkServerUrl: "检查服务器 URL 与网络连接。",
          tryAgain: "稍后重试。",
        },
      },
      serverHttpError: {
        title: "服务器诊断 HTTP 错误",
        subtitle: ({ status }: { status: string }) => `服务器返回：${status}`,
      },
      activeServerNotInProfiles: {
        title: "当前服务器不在已保存的服务器配置中",
      },
      multipleServers: {
        title: "在多台机器上检测到多个服务器",
      },
    },
  },

  connectedServices: {
    fallbackName: "已连接服务",
    title: "已连接服务",
    authChip: {
      label: "认证",
      labelWithCount: ({ count }: { count: number }) => `认证：${count}`,
    },
    list: {
      empty: "暂时没有已连接服务。",
      connectedCount: ({ count }: { count: number }) => `${count} 个已连接`,
      needsReauth: "需要重新认证",
      notConnected: "未连接",
    },
    quota: {
      loading: "加载中…",
      error: ({ message }: { message: string }) => `错误：${message}`,
      lastUpdated: ({ time }: { time: string }) => `最后更新：${time}`,
      lastUpdatedStale: ({ time }: { time: string }) =>
        `最后更新：${time} • 过期`,
      noData: "暂无配额数据",
      planLabel: ({ plan }: { plan: string }) => `方案：${plan}`,
    },
    oauthPaste: {
      invalidConfig: "已连接服务配置无效。",
      connectWebGroupTitle: "连接（网页）",
      connectWebDescription:
        "此流程使用复制/粘贴的重定向步骤（类似 OpenClaw），并通过 Happier 服务器代理安全交换令牌。",
      openAuthorizationUrl: "打开授权 URL",
      opensInNewTab: "将在新标签页中打开",
      preparing: "准备中…",
      pasteRedirectUrl: "粘贴重定向 URL",
      pasteRedirectUrlPromptBody:
        "完成 OAuth 后，从浏览器地址栏复制最终重定向的 URL 并粘贴到这里。",
      tryDeviceInstead: "改用设备认证",
      tryEmbeddedInstead: "改用应用内浏览器",
      working: "处理中…",
      alerts: {
        connectedTitle: "已连接",
        connectedBody: ({ serviceId, profileId }: { serviceId: string; profileId: string }) =>
          `${serviceId}（${profileId}）已连接。`,
        failedToOpenUrl: "无法打开链接",
        failedToConnect: "连接失败",
      },
    },
    deviceAuth: {
      invalidConfig: "已连接服务配置无效。",
      title: "连接（设备）",
      description:
        "打开验证页面，输入代码，并保持此页面打开，直到连接完成。",
      openVerificationUrl: "打开验证页面",
      userCode: "用户代码",
      securityHint:
        "提示：点击“复制”即可复制代码。请只在 auth.openai.com 输入此代码，切勿与任何人分享。",
      deviceAuthDisabledHint:
        "如果验证页面提示设备代码授权已禁用，请在 ChatGPT 设置中启用“Enable device code authorization for Codex”，然后重试。",
      preparing: "正在准备…",
      waiting: "等待批准…",
      polling: "正在轮询批准…",
      usePasteInstead: "改用粘贴重定向 URL",
      useBrowserInstead: "改用应用内浏览器",
      alerts: {
        connectedTitle: "已连接",
        connectedBody: ({ serviceId, profileId }: { serviceId: string; profileId: string }) =>
          `${serviceId}（${profileId}）已连接。`,
        failedToConnect: "连接失败",
        failedToStart: "无法启动设备身份验证",
      },
    },
    detail: {
      unknownService: "未知的已连接服务。",
      actionsGroupTitle: "操作",
      actions: {
        setDefault: "设为默认",
        unsetDefault: "取消默认",
        editLabel: "编辑标签",
        reconnect: "重新连接",
      },
      setDefaultProfileTitle: "设置默认配置",
      setDefaultProfileSubtitleDefault: ({ profileId }: { profileId: string }) =>
        `默认：${profileId}`,
      setDefaultProfileSubtitleChoose: "选择默认使用的配置",
      setProfileLabelTitle: "设置配置标签",
      setProfileLabelSubtitle: "在授权选择器中显示的可选标签",
      addOauthProfileTitle: "添加 OAuth 配置",
      addOauthProfileSubtitle: "连接新的账号配置",
      addOauthProfileDeviceTitle: "通过设备认证添加",
      addOauthProfileDeviceSubtitle: "推荐用于 Web/远程环境",
      addOauthProfilePasteTitle: "通过粘贴重定向添加",
      addOauthProfilePasteSubtitle: "手动复制/粘贴重定向 URL 流程",
      addOauthProfileBrowserTitle: "通过应用内浏览器添加",
      addOauthProfileBrowserSubtitle: "在支持的环境中使用内嵌浏览器",
      connectApiKeyTitle: "通过 API 密钥连接",
      connectApiKeySubtitle: "粘贴 Anthropic 的 API 密钥",
      connectSetupTokenTitle: "通过 setup-token 连接",
      connectSetupTokenSubtitle: "粘贴 Claude 的 setup-token（来自 claude setup-token）",
      disconnectConfirmBody: ({ service, profileId }: { service: string; profileId: string }) =>
        `断开 ${service}（${profileId}）？`,
      prompts: {
        profileIdTitle: "配置 ID",
        profileIdBody: "使用 work、personal、alt 之类的短标签。",
        apiKeyTitle: "API 密钥",
        apiKeyBody: "粘贴你的 Anthropic API 密钥。",
        apiKeyPlaceholder: "例如 sk-ant-…",
        setupTokenTitle: "设置令牌",
        setupTokenBody: "粘贴你的 Claude setup-token（来自 claude setup-token）。",
        setupTokenPlaceholder: "例如 sk-ant-oat01-…",
        profileLabelTitle: "配置标签",
        profileLabelBody: "可选。在认证选择器中显示。",
        profileLabelPlaceholder: "工作账号",
      },
      alerts: {
        invalidProfileIdTitle: "配置 ID 无效",
        invalidProfileIdBody: "使用字母、数字、连字符或下划线（最多 64）。",
        unknownProfileTitle: "未知配置",
        unknownProfileBody: ({ profileId, service }: { profileId: string; service: string }) =>
          `在 ${service} 中不存在名为“${profileId}”的配置。`,
      },
      profiles: {
        empty: "暂无配置。",
        connected: "已连接",
        defaultBadge: "默认",
        needsReauth: "需要重新认证",
      },
    },
    profile: {
      profileId: "配置 ID",
      status: "状态",
      email: "邮箱",
      accountId: "账号 ID",
      quotaTitle: "配额",
      defaultSubtitle: "此配置默认选中",
      setDefaultSubtitle: "默认使用此配置",
      disconnectSubtitle: "移除此配置的凭据",
      reconnectSubtitle: "重新认证此配置",
    },
    authModal: {
      nativeAuthTitle: "后端原生认证",
      nativeAuthSubtitle: "使用本地 CLI 登录 / API 密钥",
      connectedServicesTitle: "使用已连接服务",
      connectedServicesSubtitle: "从 Happier 云获取并生成",
      notConnectedTitle: "未连接",
      notConnectedSubtitle: "点按打开设置",
      profileLabel: "配置文件",
    },
  },

  attachments: {
    alerts: {
      fileTooLargeTitle: "文件过大",
      fileTooLargeBody: ({ count }: { count: number }) =>
        `已跳过 ${count} 个超过最大附件大小的文件。`,
    },
  },

  settingsAttachments: {
    disabled: {
      title: "附件",
      footer: "此功能已被服务器或构建策略禁用。",
    },
    fileUploads: {
      title: "文件上传",
    },
    uploadLocation: {
      title: "上传位置",
      footer:
        "上传到工作区目录最兼容。上传到系统临时目录可用于避免在仓库中留下文件，但在更严格的沙盒中可能无法读取。",
      options: {
        workspace: {
          title: "工作区目录（推荐）",
          subtitle:
            "上传内容会写入工作区相对目录，以便代理沙盒能够可靠读取。",
        },
        osTemp: {
          title: "系统临时目录",
          subtitle:
            "上传内容会写入系统临时目录。在更严格的沙盒中可能会出问题。",
        },
      },
    },
    workspaceDirectory: {
      title: "工作区目录",
      footer: "仅在上传位置设置为工作区目录时使用。",
      uploadsDirectory: {
        title: "上传目录",
        promptTitle: "上传目录",
        promptMessage:
          "请输入工作区相对目录（不允许绝对路径，不允许 ..）。",
        invalidDirectoryTitle: "目录无效",
        invalidDirectoryMessage: "请使用相对路径，例如 `.happier/uploads`。",
      },
    },
    sourceControlIgnore: {
      title: "版本控制忽略",
      footer:
        "仅本地忽略可避免误提交。如果选择 .gitignore，可能会修改被跟踪的文件。",
      options: {
        gitInfoExclude: {
          title: "本地忽略（.git/info/exclude）（推荐）",
          subtitle: "无需修改仓库文件即可避免误提交。",
        },
        gitignore: {
          title: "通过 .gitignore 忽略",
          subtitle: "会在工作区的 .gitignore 中写入条目（可能被提交）。",
        },
        none: {
          title: "不写入忽略规则",
          subtitle:
            "根据仓库配置，上传的文件可能会被版本控制拾取。",
        },
      },
      writeIgnoreRules: {
        title: "写入忽略规则",
      },
    },
    limits: {
      title: "限制",
      footer: "这些限制由本地 CLI 上传处理器尽力执行。",
      invalidValueTitle: "值无效",
      maxAttachmentSize: {
        title: "附件最大大小（字节）",
        promptTitle: "附件最大大小（字节）",
        promptMessage: "示例：25MB 为 26214400。",
        invalidValueMessage: "请输入 1024 到 1073741824 之间的数字。",
      },
      uploadTtl: {
        title: "上传 TTL（毫秒）",
        promptTitle: "上传 TTL（毫秒）",
        promptMessage: "上传在过期前可保持空闲的时间。",
        invalidValueMessage: "请输入 5000 到 3600000 之间的数字。",
      },
      chunkSize: {
        title: "首选分块大小（字节）",
        promptTitle: "首选分块大小（字节）",
        promptMessage: "CLI 可能会将其限制在安全范围内。",
        invalidValueMessage: "请输入 4096 到 1048576 之间的数字。",
      },
    },
  },

  settingsSourceControl: {
    commitStrategy: {
      title: "提交策略",
      footer:
        "原子提交可避免多代理对索引的干扰。Git 暂存支持交互式 include/exclude 工作流。",
      options: {
        atomic: {
          title: "原子提交（推荐）",
          subtitle:
            "不会在仓库索引中进行实时暂存。一次 RPC 操作提交所有待提交更改。",
        },
        gitStaging: {
          title: "Git 暂存工作流",
          subtitle:
            "为 Git 仓库启用 include/exclude 与按行部分暂存。",
        },
      },
    },
    gitRoutingPreference: {
      title: ".git 路由偏好",
      footer: "选择当仓库模式为 .git 时优先使用的后端。",
      options: {
        git: {
          title: ".git 仓库使用 Git",
          subtitle: "默认且推荐，兼容性最好。",
        },
        sapling: {
          title: ".git 仓库优先 Sapling",
          subtitle: "当 Git 和 Sapling 都可用时使用 Sapling 后端。",
        },
      },
    },
    remoteConfirmation: {
      title: "远程确认",
      footer: "控制 pull/push 是否需要确认。",
      options: {
        always: {
          title: "始终确认 pull/push",
          subtitle: "为 pull 和 push 操作显示确认对话框。",
        },
        pushOnly: {
          title: "仅确认 push",
          subtitle: "pull 立即执行；push 需要确认。",
        },
        never: {
          title: "从不确认",
          subtitle: "立即执行 pull 和 push。",
        },
      },
    },
    pushRejectionRecovery: {
      title: "Push 被拒绝后的恢复",
      footer: "当 push 因分支落后于 upstream 而被拒绝时的行为。",
      options: {
        promptFetch: {
          title: "提示执行 fetch",
          subtitle:
            "当 non-fast-forward push 被拒绝时，在执行 fetch 前询问。",
        },
        autoFetch: {
          title: "自动 fetch",
          subtitle: "non-fast-forward push 被拒绝后自动执行 fetch。",
        },
        manual: {
          title: "手动恢复",
          subtitle: "push 被拒绝后不自动执行 fetch。",
        },
      },
    },
    commitMessageGenerator: {
      title: "提交信息生成器",
      footer:
        "可选：通过一次性 LLM 任务生成提交信息建议。需要 daemon 支持 execution runs。",
      backendItemTitle: ({ backendId }: { backendId: string }) =>
        `生成后端：${backendId}`,
      backendItemSubtitle: "用于一次性生成提交信息的后端 ID。",
      backendPromptTitle: "提交信息后端",
      backendPromptMessage: "输入后端 ID",
      instructionsPlaceholder: "提交信息指令",
    },
    commitAttribution: {
      title: "提交署名",
      footer:
        "启用后，AI 生成的提交信息将包含 Co-Authored-By 署名。",
      includeCoAuthoredBy: {
        title: "包含 Co-Authored-By",
      },
    },
    filesDisplay: {
      title: "文件显示",
      footer: "语法高亮为实验功能，超大 diff 可能会被禁用。",
      diffRenderer: {
        options: {
          pierre: {
            title: "Diff 渲染器：Pierre",
            subtitle:
              "在 web/desktop 上提供最佳 diff 渲染。使用 worker 管线，若不可用会安全降级。",
          },
          happier: {
            title: "Diff 渲染器：Happier",
            subtitle: "兼容与排障用的降级渲染器。",
          },
        },
      },
      diffPresentation: {
        options: {
          unified: {
            title: "Diff 布局：统一",
            subtitle: "内联视图（单列）。适合窄屏与快速浏览。",
          },
          split: {
            title: "Diff 布局：并排",
            subtitle: "分栏视图（双列）。适合大屏与精确对比。",
          },
        },
      },
      syntaxHighlighting: {
        options: {
          off: {
            title: "语法高亮：关闭",
            subtitle: "将 diff 与文件渲染为纯等宽文本。",
          },
          simple: {
            title: "语法高亮：简单",
            subtitle: "为常见语言提供快速的基于 token 的高亮。",
          },
          advanced: {
            title: "语法高亮：高级",
            subtitle: "在 web/desktop 上更高保真；在原生端降级为简单模式。",
          },
        },
      },
      changedFilesDensity: {
        options: {
          comfortable: {
            title: "变更文件密度：舒适",
            subtitle: "更大的行高，文件副标题与状态更清晰。",
          },
          compact: {
            title: "变更文件密度：紧凑",
            subtitle: "当变更文件很多时更易浏览的紧凑行。",
          },
        },
      },
    },
    backends: {
      backendGroupTitle: ({ backendTitle }: { backendTitle: string }) =>
        `${backendTitle} 后端`,
      defaultDiffItemTitle: ({
        backendTitle,
        diffModeTitle,
      }: {
        backendTitle: string;
        diffModeTitle: string;
      }) => `${backendTitle} 默认 diff：${diffModeTitle}`,
      defaultDiffItemSubtitle: "查看包含与待处理增量时的默认模式。",
    },
    diffMode: {
      pending: "待处理",
      combined: "合并",
      included: "已包含",
    },
  },

  settingsNotifications: {
    push: {
      title: "推送通知",
      footer:
        "当会话需要你关注时，这些通知会由你的 CLI 通过 Expo 发送。",
      enabledSubtitle: "允许此账户接收推送通知",
    },
    types: {
      title: "类型",
      footer: "如果你只想要某些提醒，可以禁用单独的类型。",
      ready: {
        title: "就绪",
        subtitle: "当一轮完成且代理正在等待你的命令时通知",
      },
      permissionRequests: {
        title: "权限请求",
        subtitle: "当会话因等待批准而被阻塞时通知",
      },
      userActions: {
        title: "操作请求",
        subtitle: "当会话需要你的回答或确认时通知",
      },
    },
  },

  notifications: {
    actions: {
      allow: '允许',
      deny: '拒绝',
      answer: '回答',
    },
    channels: {
      default: '默认',
      permissionRequests: '权限请求',
      userActionRequests: '操作请求',
    },
  },

  settingsProviders: {
    title: "AI 提供商设置",
    entrySubtitle: "配置提供商专属选项",
    footer: "配置提供商专属选项。这些设置可能会影响会话行为。",
    providerSubtitle: "提供商专属设置",
    stateEnabled: "已启用",
    stateDisabled: "已禁用",
    channelStable: "稳定版",
    channelExperimental: "实验版",
    supported: "支持",
    notSupported: "不支持",
    allowed: "允许",
    notAllowed: "不允许",
    notAvailable: "不可用",
    enabledTitle: "已启用",
    enabledSubtitle: "在选择器、配置文件和会话中使用此后端",
    releaseChannelTitle: "发布渠道",
    capabilitiesTitle: "能力",
    resumeSupportTitle: "恢复支持",
    sessionModeSupportTitle: "会话模式支持",
    runtimeModeSwitchingTitle: "运行时模式切换",
    localControlTitle: "本地控制",
    resumeSupportSupported: "支持",
    resumeSupportSupportedExperimental: "支持（实验）",
    resumeSupportRuntimeGatedAcpLoadSession:
      "通过 ACP loadSession 进行运行时门控",
    resumeSupportNotSupported: "不支持",
    sessionModeNone: "无 ACP 模式",
    sessionModeAcpPolicyPresets: "ACP 策略预设",
    sessionModeAcpAgentModes: "ACP 代理模式",
    sessionModeStaticAgentModes: "静态代理模式",
    runtimeSwitchNone: "无运行时切换",
    runtimeSwitchMetadataGating: "由元数据门控",
    runtimeSwitchAcpSetSessionMode: "ACP：setSessionMode",
    runtimeSwitchProviderNative: "提供商原生",
    modelsTitle: "模型",
    modelSelectionTitle: "模型选择",
    freeformModelIdsTitle: "自定义模型 ID",
    defaultModelTitle: "默认模型",
    catalogModelListTitle: "目录模型列表",
    catalogModelListEmpty: "没有可用的目录模型",
    dynamicModelProbeTitle: "动态模型探测",
    dynamicModelProbeAuto: "自动",
    dynamicModelProbeStaticOnly: "仅静态",
    nonAcpApplyScopeTitle: "非 ACP 模型应用范围",
    nonAcpApplyScopeSpawnOnly: "在会话开始时应用",
    nonAcpApplyScopeNextPrompt: "在下一条消息时应用",
    acpApplyBehaviorTitle: "ACP 模型应用行为",
    acpApplyBehaviorSetModel: "实时设置模型",
    acpApplyBehaviorRestartSession: "重启会话",
    acpConfigOptionTitle: "ACP 模型配置选项 ID",
    cliConnectionTitle: "CLI 与连接",
    targetMachineTitle: "目标机器",
    detectedCliTitle: "检测到的 CLI",
    installSetupTitle: "安装 / 设置",
    installInfoSeeSetupGuide: "查看设置指南",
    installInfoUseProviderCliInstaller: "使用提供商的 CLI 安装器",
    cliInstaller: {
      installTitle: ({ provider }: { provider: string }) => `安装 ${provider} CLI`,
      reinstallTitle: ({ provider }: { provider: string }) =>
        `重新安装 ${provider} CLI`,
      autoInstallUnavailable: "此机器不支持自动安装。",
      installSubtitle: "在所选机器上安装提供商 CLI（尽力而为）。",
      reinstallSubtitle: "即使已安装 CLI 也会重新运行安装器。",
      noMachineSelected: "未选择机器。",
      installNotSupported: "此机器不支持安装。",
      installFailed: "安装失败。",
      installed: "已安装。",
      logPath: ({ logPath }: { logPath: string }) => `日志：${logPath}`,
    },
    setupGuideUrlTitle: "设置指南 URL",
    connectedServiceTitle: "已连接服务",
    notFoundTitle: "未找到提供商",
    notFoundSubtitle: "该提供商没有设置页面。",
    noOptionsAvailable: "没有可用选项",
    invalidNumber: "无效数字",
    invalidJson: "无效 JSON",
  },

  settingsAppearance: {
    // Appearance settings screen
    theme: "主题",
    themeDescription: "选择您喜欢的配色方案",
    themeOptions: {
      adaptive: "自适应",
      light: "浅色",
      dark: "深色",
    },
    themeDescriptions: {
      adaptive: "跟随系统设置",
      light: "始终使用浅色主题",
      dark: "始终使用深色主题",
    },
    display: "显示",
    displayDescription: "控制布局和间距",
    multiPanePanels: "右侧面板",
    multiPanePanelsDescription: "显示可调整大小的右侧文件/源代码控制面板（Web/平板）",
    sessionsRightPaneDefaultOpen: "在会话中始终显示右侧边栏",
    sessionsRightPaneDefaultOpenDescription: "进入会话时自动打开右侧边栏（Web/平板）",
    detailsPaneTabsBehavior: "编辑器标签页",
    detailsPaneTabsBehaviorDescription: "选择编辑器面板中的文件标签页行为",
    detailsPaneTabsBehaviorOptions: {
      preview: "预览标签页",
      persistent: "固定标签页",
    },
    editorFocusMode: "编辑器专注模式",
    editorFocusModeDescription: "在查看文件时隐藏会话和侧边栏（Web/平板）",
    inlineToolCalls: "内联工具调用",
    inlineToolCallsDescription: "在聊天消息中直接显示工具调用",
    expandTodoLists: "展开待办列表",
    expandTodoListsDescription: "显示所有待办事项而不仅仅是变更",
    showLineNumbersInDiffs: "在差异中显示行号",
    showLineNumbersInDiffsDescription: "在代码差异中显示行号",
    showLineNumbersInToolViews: "在工具视图中显示行号",
    showLineNumbersInToolViewsDescription: "在工具视图差异中显示行号",
    wrapLinesInDiffs: "在差异中换行",
    wrapLinesInDiffsDescription: "在差异视图中换行显示长行而不是水平滚动",
    alwaysShowContextSize: "始终显示上下文大小",
    alwaysShowContextSizeDescription: "即使未接近限制时也显示上下文使用情况",
    agentInputActionBarLayout: "输入操作栏",
    agentInputActionBarLayoutDescription: "选择在输入框上方如何显示操作标签",
    agentInputActionBarLayoutOptions: {
      auto: "自动",
      wrap: "换行",
      scroll: "可滚动",
      collapsed: "折叠",
    },
    agentInputChipDensity: "操作标签密度",
    agentInputChipDensityDescription: "选择操作标签显示文字还是图标",
    agentInputChipDensityOptions: {
      auto: "自动",
      labels: "文字",
      icons: "仅图标",
    },
    avatarStyle: "头像风格",
    avatarStyleDescription: "选择会话头像外观",
    avatarOptions: {
      pixelated: "像素化",
      gradient: "渐变",
      brutalist: "粗糙风格",
    },
    showFlavorIcons: "显示 AI 提供商图标",
    showFlavorIconsDescription: "在会话头像上显示 AI 提供商图标",
    compactSessionView: "紧凑会话视图",
    compactSessionViewDescription: "以更紧凑的布局显示活跃会话",
    compactSessionViewMinimal: "极简紧凑视图",
    compactSessionViewMinimalDescription: "隐藏头像并显示更紧凑的会话行布局",
    text: "文本",
    textDescription: "调整应用内文字大小",
    textSize: "文字大小",
    textSizeDescription: "让文字更大或更小",
    textSizeOptions: {
      xxsmall: "超特小",
      xsmall: "特小",
      small: "小",
      default: "默认",
      large: "大",
      xlarge: "特大",
      xxlarge: "超特大",
    },
  },

  settingsFeatures: {
    // Features settings screen
    experiments: "实验功能",
    experimentsDescription:
      "启用仍在开发中的实验功能。这些功能可能不稳定或会在没有通知的情况下改变。",
    experimentalFeatures: "实验功能",
    experimentalFeaturesEnabled: "实验功能已启用",
    experimentalFeaturesDisabled: "仅使用稳定功能",
    experimentalOptions: "实验选项",
    experimentalOptionsDescription: "选择启用哪些实验功能。",
    localTogglesTitle: "功能",
    localTogglesFooter: "每个功能的本地开关（与服务器支持无关）。",
    featureDiagnostics: {
      title: "功能诊断",
      footer:
        "解析后的功能决策（构建策略、本地策略、守护进程/服务器探测与作用域）。",
      decisionUnknown: "未知",
      decisionEnabled: "已启用",
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
    expAutomations: "自动化",
    expAutomationsSubtitle: "启用自动化界面与定时调度",
    expExecutionRuns: "执行运行",
    expExecutionRunsSubtitle:
      "启用执行运行（子代理/审查）控制平面界面",
    expAttachmentsUploads: "附件上传",
    expAttachmentsUploadsSubtitle:
      "启用文件/图片上传，让代理可以从磁盘读取",
    expUsageReporting: "用量报告",
    expUsageReportingSubtitle: "启用用量与 token 报告页面",
    expScmOperations: "版本控制操作",
    expScmOperationsSubtitle:
      "启用实验性的版本控制写入操作（stage/commit/push/pull）",
    expFilesReviewComments: "文件审查评论",
    expFilesReviewCommentsSubtitle:
      "在文件与差异视图添加逐行审查评论，并作为结构化消息发送",
    expFilesDiffSyntaxHighlighting: "差异语法高亮",
    expFilesDiffSyntaxHighlightingSubtitle:
      "在差异与代码视图启用语法高亮（有性能限制）",
    expFilesAdvancedSyntaxHighlighting: "高级语法高亮",
    expFilesAdvancedSyntaxHighlightingSubtitle:
      "使用更重、更高保真的语法高亮（仅 Web，可能更慢）",
    expFilesEditor: "内嵌文件编辑器",
    expFilesEditorSubtitle:
      "允许从文件浏览器直接编辑文件（Web/桌面用 Monaco，原生用 CodeMirror）",
    expSessionType: "会话类型选择器",
    expSessionTypeSubtitle:
      "显示会话类型选择器（简单 vs worktree）",
    expZen: "Zen",
    expZenSubtitle: "启用 Zen 导航入口",
    expVoiceAuthFlow: "语音认证流程",
    expVoiceAuthFlowSubtitle:
      "使用带认证的语音 token 流程（支持付费墙）",
    voice: "语音",
    voiceSubtitle: "启用语音功能",
    expVoiceAgent: "语音代理",
    expVoiceAgentSubtitle: "启用基于守护进程的语音代理界面（需要执行运行）",
    expConnectedServices: "已连接的服务",
    expConnectedServicesSubtitle: "启用已连接服务设置与会话绑定",
    expConnectedServicesQuotas: "已连接服务配额",
    expConnectedServicesQuotasSubtitle: "显示已连接服务的配额徽标与用量仪表",
    expMemorySearch: "记忆搜索",
    expMemorySearchSubtitle: "启用本地记忆搜索页面与设置",
    expFriends: "好友",
    expFriendsSubtitle: "启用好友功能（收件箱标签页与会话分享）",
    webFeatures: "Web 功能",
    webFeaturesDescription: "仅在应用的 Web 版本中可用的功能。",
    enterToSend: "回车发送",
    enterToSendEnabled: "按回车发送（Shift+回车换行）",
    enterToSendDisabled: "回车换行",
    historyScope: "消息历史",
    historyScopePerSession: "仅在当前终端循环历史",
    historyScopeGlobal: "在所有终端循环历史",
    historyScopeModalTitle: "消息历史",
    historyScopeModalMessage:
      "选择方向键上/下是仅在此终端发送的消息间循环，还是在所有终端间循环。",
    historyScopePerSessionOption: "按终端",
    historyScopeGlobalOption: "全局",
      commandPalette: "命令面板",
      commandPaletteEnabled: "按 ⌘K 打开",
      commandPaletteDisabled: "快速命令访问已禁用",
      hideInactiveSessions: "隐藏非活跃会话",
      hideInactiveSessionsSubtitle: "仅在列表中显示活跃的聊天",
    sessionListActiveGrouping: "活跃会话分组",
    sessionListActiveGroupingSubtitle: "选择侧边栏中活跃会话的分组方式",
    sessionListInactiveGrouping: "非活跃会话分组",
    sessionListInactiveGroupingSubtitle: "选择侧边栏中非活跃会话的分组方式",
    sessionListGrouping: {
      projectTitle: "项目",
      projectSubtitle: "按机器 + 路径分组会话",
      dateTitle: "日期",
      dateSubtitle: "按最近活动日期分组会话",
    },
    groupInactiveSessionsByProject: "按项目分组非活跃会话",
    groupInactiveSessionsByProjectSubtitle: "按项目整理非活跃聊天",
    environmentBadge: "环境徽标",
    environmentBadgeSubtitle:
      "在 Happier 标题旁显示小徽标，指示当前应用环境",
    enhancedSessionWizard: "增强会话向导",
    enhancedSessionWizardEnabled: "配置文件优先启动器已激活",
    enhancedSessionWizardDisabled: "使用标准会话启动器",
    profiles: "AI 配置文件",
    profilesEnabled: "已启用配置文件选择",
    profilesDisabled: "已禁用配置文件选择",
    pickerSearch: "选择器搜索",
    pickerSearchSubtitle: "在设备和路径选择器中显示搜索框",
    machinePickerSearch: "设备搜索",
    machinePickerSearchSubtitle: "在设备选择器中显示搜索框",
    pathPickerSearch: "路径搜索",
    pathPickerSearchSubtitle: "在路径选择器中显示搜索框",
  },

  errors: {
    networkError: "发生网络错误",
    serverError: "发生服务器错误",
    unknownError: "发生未知错误",
    connectionTimeout: "连接超时",
    authenticationFailed: "认证失败",
    permissionDenied: "权限被拒绝",
      fileNotFound: "文件未找到",
      invalidFormat: "格式无效",
      operationFailed: "操作失败",
      failedToForkSession: "分叉会话失败",
      daemonUnavailableTitle: "守护进程不可用",
      daemonUnavailableBody:
        "Happier 无法连接到此设备上的守护进程。它可能离线、仍在启动，或与服务器断开连接。",
      tryAgain: "请重试",
      contactSupport: "如果问题持续存在，请联系支持",
      sessionNotFound: "会话未找到",
      voiceSessionFailed: "启动语音会话失败",
      voiceServiceUnavailable: "语音服务暂时不可用",
    voiceAlreadyStarting: "语音已在另一个会话中启动",
    oauthInitializationFailed: "初始化 OAuth 流程失败",
    tokenStorageFailed: "存储认证令牌失败",
    oauthStateMismatch: "安全验证失败。请重试",
    providerAlreadyLinked: ({ provider }: { provider: string }) =>
      `${provider} 已关联到现有的 Happier 账号。要在此设备上登录，请从已登录的设备中将此设备进行关联。`,
    tokenExchangeFailed: "交换授权码失败",
    oauthAuthorizationDenied: "授权被拒绝",
    webViewLoadFailed: "加载认证页面失败",
    failedToLoadProfile: "无法加载用户资料",
    userNotFound: "未找到用户",
    sessionDeleted: "会话不可用",
    sessionDeletedDescription: "它可能已被删除，或您可能不再拥有访问权限。",

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
    }) => `${field} 必须在 ${min} 和 ${max} 之间`,
    retryIn: ({ seconds }: { seconds: number }) => `${seconds} 秒后重试`,
    errorWithCode: ({
      message,
      code,
    }: {
      message: string;
      code: number | string;
    }) => `${message} (错误 ${code})`,
    disconnectServiceFailed: ({ service }: { service: string }) =>
      `断开连接 ${service} 失败`,
    connectServiceFailed: ({ service }: { service: string }) =>
      `连接 ${service} 失败。请重试。`,
    failedToLoadFriends: "加载好友列表失败",
    failedToAcceptRequest: "接受好友请求失败",
    failedToRejectRequest: "拒绝好友请求失败",
    failedToRemoveFriend: "删除好友失败",
    searchFailed: "搜索失败。请重试。",
    failedToSendRequest: "发送好友请求失败",
    failedToResumeSession: "恢复会话失败",
    failedToSendMessage: "发送消息失败",
    failedToSwitchControl: "切换控制模式失败",
    cannotShareWithSelf: "不能与自己分享",
    canOnlyShareWithFriends: "只能与好友分享",
    shareNotFound: "未找到分享",
    publicShareNotFound: "公开分享未找到或已过期",
    consentRequired: "需要同意才能访问",
    maxUsesReached: "已达到最大使用次数",
    invalidShareLink: "无效或已过期的共享链接",
    missingPermissionId: "缺少权限请求 ID",
    codexResumeNotInstalledTitle: "此机器未安装 Codex resume",
    codexResumeNotInstalledMessage:
      "要恢复 Codex 对话，请在目标机器上安装 Codex resume 服务器（机器详情 → Installables）。",
    codexAcpNotInstalledTitle: "此机器未安装 Codex ACP",
    codexAcpNotInstalledMessage:
      "要使用 Codex ACP 实验功能，请在目标机器上安装 codex-acp（机器详情 → Installables），或关闭实验开关。",
  },

  deps: {
    installNotSupported: "请更新 Happier CLI 以安装此依赖项。",
    installFailed: "安装失败",
    installed: "已安装",
    installLog: ({ path }: { path: string }) => `安装日志：${path}`,
    installable: {
      codexResume: {
        title: "Codex 恢复服务器",
        installSpecTitle: "Codex resume 安装来源",
      },
      codexAcp: {
        title: "Codex ACP 适配器",
        installSpecTitle: "Codex ACP 安装来源",
      },
      installSpecDescription:
        "传给 `npm install` 的 NPM/Git/文件规格（实验性）。留空则使用守护进程默认值。",
    },
    ui: {
      notAvailable: "不可用",
      notAvailableUpdateCli: "不可用（请更新 CLI）",
      errorRefresh: "错误（刷新）",
      installed: "已安装",
      installedWithVersion: ({ version }: { version: string }) =>
        `已安装（v${version}）`,
      installedUpdateAvailable: ({
        installedVersion,
        latestVersion,
      }: {
        installedVersion: string;
        latestVersion: string;
      }) => `已安装（v${installedVersion}）— 有更新（v${latestVersion}）`,
      notInstalled: "未安装",
      latest: "最新",
      latestSubtitle: ({ version, tag }: { version: string; tag: string }) =>
        `${version}（标签：${tag}）`,
      registryCheck: "注册表检查",
      registryCheckFailed: ({ error }: { error: string }) => `失败：${error}`,
      installSource: "安装来源",
      installSourceDefault: "（默认）",
      installSpecPlaceholder:
        "例如 file:/path/to/pkg 或 github:owner/repo#branch",
      lastInstallLog: "上次安装日志",
      installLogTitle: "安装日志",
    },
  },

  newSession: {
    // Used by new-session screen and launch flows
    title: "启动新会话",
    selectAiProfileTitle: "选择 AI 配置",
    selectAiProfileDescription:
      "选择一个 AI 配置，以将环境变量和默认值应用到会话。",
    changeProfile: "更改配置",
    aiBackendSelectedByProfile:
      "AI 后端由所选配置决定。如需更改，请选择其他配置。",
    selectAiBackendTitle: "选择 AI 后端",
    aiBackendLimitedByProfileAndMachineClis:
      "受所选配置和此设备上可用的 CLI 限制。",
    aiBackendSelectWhichAiRuns: "选择由哪个 AI 运行会话。",
    aiBackendNotCompatibleWithSelectedProfile: "与所选配置不兼容。",
    aiBackendCliNotDetectedOnMachine: ({ cli }: { cli: string }) =>
      `此设备未检测到 ${cli} CLI。`,
    selectMachineTitle: "选择设备",
    selectMachineDescription: "选择此会话运行的位置。",
    selectPathTitle: "选择路径",
    selectWorkingDirectoryTitle: "选择工作目录",
    selectWorkingDirectoryDescription: "选择用于命令和上下文的文件夹。",
    selectPermissionModeTitle: "选择权限模式",
    selectPermissionModeDescription: "控制操作需要批准的严格程度。",
    selectModelTitle: "选择 AI 模型",
    selectModelDescription: "选择此会话使用的模型。",
    selectSessionTypeTitle: "选择会话类型",
    selectSessionTypeDescription: "选择简单会话或与 Git worktree 关联的会话。",
    searchPathsPlaceholder: "搜索路径...",
    noMachinesFound: "未找到设备。请先在您的计算机上启动 Happier 会话。",
    allMachinesOffline: "所有设备似乎都已离线",
    machineDetails: "查看设备详情 →",
    directoryDoesNotExist: "目录不存在",
    createDirectoryConfirm: ({ directory }: { directory: string }) =>
      `目录 ${directory} 不存在。您要创建它吗？`,
    sessionStarted: "会话已启动",
    sessionStartedMessage: "会话已成功启动。",
    sessionSpawningFailed: "会话生成失败 - 未返回会话 ID。",
    startingSession: "正在启动会话...",
    startNewSessionInFolder: "在此文件夹中启动新会话",
    failedToStart: "启动会话失败。确保守护进程在目标设备上运行。",
    sessionTimeout: "会话启动超时。设备可能运行缓慢或守护进程可能无响应。",
    notConnectedToServer: "未连接到服务器。请检查您的网络连接。",
    daemonRpcUnavailableTitle: "守护进程不可用",
    daemonRpcUnavailableBody:
      "Happier 无法连接到此设备上的守护进程。它可能离线、仍在启动，或与服务器断开连接。",
    noMachineSelected: "请选择一台设备以启动会话",
    noPathSelected: "请选择一个目录以启动会话",
    machinePicker: {
      searchPlaceholder: "搜索设备...",
      recentTitle: "最近",
      favoritesTitle: "收藏",
      allTitle: "全部",
      emptyMessage: "没有可用设备",
    },
    pathPicker: {
      enterPathTitle: "输入路径",
      enterPathPlaceholder: "输入路径...",
      customPathTitle: "自定义路径",
      recentTitle: "最近",
      favoritesTitle: "收藏",
      suggestedTitle: "推荐",
      allTitle: "全部",
      emptyRecent: "没有最近的路径",
      emptyFavorites: "没有收藏的路径",
      emptySuggested: "没有推荐的路径",
      emptyAll: "没有路径",
    },
    sessionType: {
      title: "会话类型",
      simple: "简单",
      worktree: "Worktree（Git）",
      comingSoon: "即将推出",
    },
    profileAvailability: {
      requiresAgent: ({ agent }: { agent: string }) => `需要 ${agent}`,
      cliNotDetected: ({ cli }: { cli: string }) => `未检测到 ${cli} CLI`,
    },
    cliBanners: {
      cliNotDetectedTitle: ({ cli }: { cli: string }) => `${cli} CLI 未检测到`,
      dontShowFor: "不再显示此提示：",
      thisMachine: "此设备",
      anyMachine: "所有设备",
      installCommand: ({ command }: { command: string }) =>
        `安装：${command} •`,
      installCliIfAvailable: ({ cli }: { cli: string }) =>
        `如可用请安装 ${cli} CLI •`,
      viewInstallationGuide: "查看安装指南 →",
      viewGeminiDocs: "查看 Gemini 文档 →",
    },
    worktree: {
      creating: ({ name }: { name: string }) =>
        `正在创建 worktree '${name}'...`,
      notGitRepo: "Worktree 需要 git 仓库",
      failed: ({ error }: { error: string }) => `创建 worktree 失败：${error}`,
      success: "Worktree 创建成功",
    },
    resume: {
      title: "恢复会话",
      optional: "恢复：可选",
      pickerTitle: "恢复会话",
      subtitle: ({ agent }: { agent: string }) =>
        `粘贴 ${agent} 会话 ID 以恢复`,
      placeholder: ({ agent }: { agent: string }) => `粘贴 ${agent} 会话 ID…`,
      paste: "粘贴",
      save: "保存",
      clearAndRemove: "清除",
      helpText: "你可以在“会话信息”页面找到会话 ID。",
      cannotApplyBody: "此恢复 ID 当前无法应用。Happier 将改为启动一个新会话。",
    },
    codexResumeBanner: {
      title: "Codex 续接",
      updateAvailable: "有可用更新",
      systemCodexVersion: ({ version }: { version: string }) =>
        `系统 codex：${version}`,
      resumeServerVersion: ({ version }: { version: string }) =>
        `Codex resume 服务器：${version}`,
      notInstalled: "未安装",
      latestVersion: ({ version }: { version: string }) => `(最新 ${version})`,
      registryCheckFailed: ({ error }: { error: string }) =>
        `注册表检查失败：${error}`,
      install: "安装",
      update: "更新",
      reinstall: "重新安装",
    },
    codexResumeInstallModal: {
      installTitle: "安装 Codex resume？",
      updateTitle: "更新 Codex resume？",
      reinstallTitle: "重新安装 Codex resume？",
      description: "这将安装一个仅用于恢复操作的实验性 Codex MCP 服务器封装。",
    },
    codexAcpBanner: {
      title: "Codex ACP",
      install: "安装",
      update: "更新",
      reinstall: "重新安装",
    },
    codexAcpInstallModal: {
      installTitle: "安装 Codex ACP？",
      updateTitle: "更新 Codex ACP？",
      reinstallTitle: "重新安装 Codex ACP？",
      description:
        "这将安装一个围绕 Codex 的实验性 ACP 适配器，用于加载/恢复线程。",
    },
  },

  sessionHistory: {
    // Used by session history screen
    title: "会话历史",
    empty: "未找到会话",
    today: "今天",
    yesterday: "昨天",
    daysAgo: ({ count }: { count: number }) => `${count} 天前`,
    viewAll: "查看所有会话",
  },

  session: {
    inputPlaceholder: "输入消息...",
    activity: "活动",
    activityCollapsedPreviewMore: ({ count }: { count: number }) => `+${count} 更多…`,
    forking: {
      dividerTitle: "从较早的上下文分叉",
      dividerSubtitle: "较早上下文（只读）",
      openParent: "打开",
      openParentA11y: "打开父会话",
      forkFromMessageA11y: "从此消息分叉",
    },
    resuming: "正在恢复...",
    resumeFailed: "恢复会话失败",
    resumeSupportNoteChecking:
      "注意：Happier 仍在检查此机器是否可以恢复提供方会话。",
    resumeSupportNoteUnverified: "注意：Happier 无法验证此机器的恢复支持情况。",
    resumeSupportDetails: {
      cliNotDetected: "未在机器上检测到 CLI。",
      capabilityProbeFailed: "能力检查失败。",
      acpProbeFailed: "ACP 检查失败。",
      loadSessionFalse: "代理不支持加载会话。",
    },
    inactiveResumable: "未激活（可恢复）",
    inactiveMachineOffline: "未激活（机器离线）",
    inactiveNotResumable: "未激活",
    inactiveNotResumableNoticeTitle: "此会话无法恢复",
    inactiveNotResumableNoticeBody: ({ provider }: { provider: string }) =>
      `此会话已结束，且由于 ${provider} 不支持在此处恢复其上下文，因此无法恢复。请开始新会话以继续。`,
    machineOfflineNoticeTitle: "机器离线",
      machineOfflineNoticeBody: ({ machine }: { machine: string }) =>
        `“${machine}” 处于离线状态，因此 Happier 目前无法恢复此会话。请将机器恢复在线后继续。`,
    machineOfflineCannotResume: "机器离线。请将其恢复在线后再恢复此会话。",
      openRuns: "打开会话运行",
      openAutomations: "打开会话自动化",
      participants: {
        to: '发送给',
        lead: '主助手',
        sendToTitle: '发送给',
        broadcast: ({ teamId }: { teamId: string }) => `广播：${teamId}`,
        executionRun: ({ runId }: { runId: string }) => `运行 ${runId}`,
        cardTo: ({ label }: { label: string }) => `发送给：${label}`,
        unsupportedAttachmentsOrReviewComments: '发送给指定对象目前不支持附件或评审评论。',
      },
      actionMenu: {
        openA11y: "打开会话操作",
      },
    detailsPanel: {
      emptyHint: "从右侧面板打开文件或差异。",
      unsupportedTab: "不支持的详情标签页。",
      closeA11y: "关闭详情",
      openTabA11y: ({ title }: { title: string }) => `打开标签页 ${title}`,
      pinTabA11y: "固定标签页",
      pinnedTabA11y: "已固定标签页",
      closeTabA11y: "关闭标签页",
      enterFocusModeA11y: "进入编辑器专注模式",
      exitFocusModeA11y: "退出编辑器专注模式",
    },

    actionsDraft: {
      noInputHints: "此操作没有输入提示。",
    },

    planOutput: {
      title: "计划",
      recommendedBackend: "推荐后端",
      risks: "风险",
      milestones: "里程碑",
      adoptPlan: "采用计划",
      sending: "正在发送…",
      failedToAdopt: "采用计划失败",
      a11y: {
        adoptPlan: "采用计划",
      },
    },

    reviewFindings: {
      title: ({ count }: { count: number }) => `审查发现 (${count})`,
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
        untriaged: "未分诊",
        accept: "接受",
        reject: "拒绝",
        defer: "延后",
        needsRefinement: "需要完善",
      },
      refinementPlaceholder: "用于完善的可选备注",
      actions: {
        applyTriage: "应用分诊",
        applying: "正在应用…",
        applyAcceptedFindings: "应用已接受的发现",
        sending: "正在发送…",
      },
      errors: {
        applyTriageFailed: "应用分诊失败。",
        applyAcceptedFailed: "应用已接受的发现失败。",
      },
    },

      pendingMessages: {
        title: "待发送消息",
        indicator: ({ count }: { count: number }) => `待发送 (${count})`,
        badgeLabel: ({ count }: { count: number }) =>
          count > 0 ? `待发送 (+${count})` : "待发送",
        empty: "没有待发送消息。",
        actions: {
          up: "上移",
          down: "下移",
          edit: "编辑",
            viewMore: "查看更多",
            viewLess: "收起",
          steerNow: "立即插入",
          sendNow: "立即发送",
          sendNowInterrupt: "立即发送（中断）",
          requeue: "重新入队",
        },
        editPrompt: {
          title: "编辑待发送消息",
        },
        removeConfirm: {
          title: "移除待发送消息？",
          body: "这将删除待发送消息。",
        },
        steerConfirm: {
          title: "立即插入？",
          body: "这会在不停止当前轮次的情况下，将此消息加入当前轮次。",
        },
        sendConfirm: {
          title: "立即发送？",
          interruptTitle: "立即发送（中断）？",
          body: "这会停止当前轮次并立即发送此消息。",
        },
        discarded: {
          title: "已丢弃消息",
          subtitle: "这些消息未发送给代理（例如从远程切换到本地时）。",
          label: "已丢弃",
          removeConfirm: {
            title: "移除已丢弃消息？",
            body: "这将删除已丢弃消息。",
          },
        },
        errors: {
          updateFailed: "更新待发送消息失败",
          deleteFailed: "删除待发送消息失败",
          sendFailed: "发送待发送消息失败",
          restoreFailed: "恢复已丢弃消息失败",
          deleteDiscardedFailed: "删除已丢弃消息失败",
          sendDiscardedFailed: "发送已丢弃消息失败",
          reorderFailed: "重新排序待发送消息失败",
        },
      },
      sharing: {
        title: "共享",
        directSharing: "直接共享",
        addShare: "与好友共享",
      accessLevel: "访问级别",
      shareWith: "共享给",
      sharedWith: "已共享给",
      noShares: "未共享",
      viewOnly: "仅查看",
      viewOnlyDescription: "可查看会话，但无法发送消息。",
      viewOnlyMode: "仅查看（共享会话）",
      noEditPermission: "您对此会话只有只读访问权限。",
      canEdit: "可编辑",
      canEditDescription: "可发送消息。",
      canManage: "可管理",
      canManageDescription: "可管理共享设置。",
      manageSharingDenied: "您没有权限管理此会话的共享设置。",
      stopSharing: "停止分享",
      recipientMissingKeys: "此用户尚未注册加密密钥。",
      permissionApprovals: "权限审批",
      allowPermissionApprovals: "允许审批权限",
      allowPermissionApprovalsDescription:
        "允许此用户批准权限请求（可能会授予对您的机器的访问）。",
      permissionApprovalsDisabledTitle: "权限审批不可用",
      permissionApprovalsDisabledPublic: "公开分享为只读，无法批准权限请求。",
      permissionApprovalsDisabledReadOnly: "只读访问无法批准权限请求。",
      permissionApprovalsDisabledInactive: "该会话处于非活动状态，无法批准权限请求。",
      permissionApprovalsDisabledNotGranted:
        "拥有者未授予您批准权限请求的权限。",
      publicReadOnlyTitle: "只读（公开分享）",
      publicReadOnlyBody:
        "此会话通过公开链接共享。您可以查看内容，但无法发送消息或批准权限。",

      publicLink: "公开链接",
      publicLinkActive: "公开链接已启用",
      publicLinkDescription: "创建一个任何人都可以查看此会话的链接。",
      createPublicLink: "创建公开链接",
      regeneratePublicLink: "重新生成公开链接",
      deletePublicLink: "删除公开链接",
      linkToken: "链接令牌",
      tokenNotRecoverable: "令牌不可用",
      tokenNotRecoverableDescription:
        "出于安全原因，公开链接令牌以哈希形式存储，无法恢复。请重新生成链接以创建新令牌。",

      expiresIn: "有效期",
      expiresOn: "到期日期",
      days7: "7 天",
      days30: "30 天",
      never: "永不过期",

      maxUsesLabel: "最大使用次数",
      unlimited: "无限制",
      uses10: "10 次使用",
      uses50: "50 次使用",
      usageCount: "使用次数",
      usageCountWithMax: ({ used, max }: { used: number; max: number }) =>
        `${used}/${max} 次使用`,
      usageCountUnlimited: ({ used }: { used: number }) => `${used} 次使用`,

      requireConsent: "需要同意",
      requireConsentDescription: "在记录访问前请求同意。",
      consentRequired: "需要同意",
      consentDescription: "此链接需要您同意记录您的 IP 地址和用户代理。",
      acceptAndView: "同意并查看",
      sharedBy: ({ name }: { name: string }) => `由 ${name} 分享`,

      shareNotFound: "共享链接不存在或已过期",
      failedToDecrypt: "无法解密会话",
      noMessages: "暂无消息",
      session: "会话",
    },
  },

  commandPalette: {
    placeholder: "输入命令或搜索...",
    noCommandsFound: "未找到命令",
  },

  commandView: {
    completedWithNoOutput: "[命令完成且无输出]",
  },

  delegation: {
    output: {
      title: "委派",
      deliverablesTitle: "交付物",
    },
  },

  modelPickerOverlay: {
    refreshModelsA11y: "刷新模型",
    loadingModelsA11y: "正在加载模型…",
    refreshingModelsA11y: "正在刷新模型…",
    searchPlaceholder: "搜索模型…",
    customTitle: "自定义…",
    effectiveLabel: ({ label }: { label: string }) => `生效：${label}`,
  },

  voiceAssistant: {
    connecting: "连接中...",
    active: "语音助手已启用",
    connectionError: "连接错误",
    label: "语音助手",
    tapToEnd: "点击结束",
  },

  voiceSurface: {
    start: "开始",
    stop: "停止",
    selectSessionToStart: "请选择一个会话以开始语音",
    targetSession: "目标会话",
    noTarget: "未选择会话",
    clearTarget: "清除目标",
    a11y: {
      teleport: "传送语音代理",
      toggleActivity: "切换语音活动",
      clearActivity: "清除语音活动",
    },
  },

  voiceActivity: {
    title: "语音活动",
    empty: "暂无语音活动。",
    clear: "清除",
    format: {
      voiceAgent: "语音代理",
      you: "你",
      assistant: "助手",
      assistantStreaming: "助手…",
      action: "操作",
      error: "错误",
      status: "状态",
      started: "已开始",
      stopped: "已停止",
      errorFallback: "错误",
      eventFallback: "事件",
    },
  },

  server: {
    // Used by Server Configuration screen (app/(app)/server.tsx)
    serverConfiguration: "服务器配置",
    enterServerUrl: "请输入服务器 URL",
    notValidHappyServer: "不是有效的 Happier 服务器",
    changeServer: "更改服务器",
    continueWithServer: "继续使用此服务器？",
    resetToDefault: "重置为默认",
    resetServerDefault: "重置服务器为默认值？",
    validating: "验证中...",
    validatingServer: "正在验证服务器...",
    serverReturnedError: "服务器返回错误",
    failedToConnectToServer: "连接服务器失败",
    currentlyUsingCustomServer: "当前使用自定义服务器",
    customServerUrlLabel: "自定义服务器 URL",
    advancedFeatureFooter:
      "这是一个高级功能。只有在您知道自己在做什么时才更改服务器。更改服务器后您需要重新登录。",
    useThisServer: "使用此服务器",
    autoConfigHint:
      "如果您自行托管：请先配置服务器，然后登录（或创建账户），再连接您的终端。",
    renameServer: "重命名服务器",
    renameServerPrompt: "请输入此服务器的新名称。",
    renameServerGroup: "重命名服务器组",
    renameServerGroupPrompt: "请输入此服务器组的新名称。",
    serverNamePlaceholder: "服务器名称",
    cannotRenameCloud: "无法重命名云服务器。",
    removeServer: "移除服务器",
    removeServerConfirm: ({ name }: { name: string }) =>
      `从已保存的服务器中移除“${name}”？`,
    removeServerGroup: "移除服务器组",
    removeServerGroupConfirm: ({ name }: { name: string }) =>
      `从已保存的服务器组中移除“${name}”？`,
    cannotRemoveCloud: "无法移除云服务器。",
    signOutThisServer: "同时从此服务器退出登录？",
    signOutThisServerPrompt:
      "在此设备上找到了此服务器的已保存凭据。",
    savedServersTitle: "已保存的服务器",
    signedIn: "已登录",
    signedOut: "未登录",
    authStatusUnknown: "认证状态未知",
    switchToServer: "切换到此服务器",
    active: "当前",
    default: "默认",
    addServerTitle: "添加服务器",
    switchForThisTab: "仅为此标签页切换",
    makeDefaultOnDevice: "设为此设备默认",
    serverNameLabel: "服务器名称",
    addAndUse: "添加并使用",
    addTargetsTitle: "添加",
    addServerSubtitle: "添加新服务器并切换到它",
    notificationAddServerHint: "此服务器尚未在此设备上保存。请在下方添加以继续。",
    serverCount: ({ count }: { count: number }) => `${count} 个服务器`,
    useCanonicalServerUrlTitle: "使用服务器的规范 URL？",
    useCanonicalServerUrlBody:
      "该服务器提供了一个应可在其他设备上使用的规范 URL。要用它替代你输入的那个吗？",
    insecureHttpUrlTitle: "不安全的服务器 URL",
    insecureHttpUrlBody:
      "此 URL 使用 http://，可能无法在手机或局域网外正常工作。建议尽量使用 HTTPS。仍要继续吗？",
    signedOutSwitchConfirmTitle: "未连接",
    signedOutSwitchConfirmBody:
      "切换到此服务器并返回主页，以便登录或创建账户？",
    addServerGroupTitle: "添加服务器组",
    addServerGroupSubtitle: "创建可复用的服务器组",
    serverGroupNameLabel: "组名称",
    serverGroupNamePlaceholder: "我的服务器组",
    serverGroupServersLabel: "服务器",
    saveServerGroup: "保存组",
    serverGroupMustHaveServer: "服务器组至少需要包含一个服务器。",
    multiServerView: {
      title: "多服务器并行视图",
      footer: "选择是否将多个服务器合并到一个会话列表中显示。",
      enableTitle: "启用并行视图",
      enableSubtitle: "将所选服务器的会话合并显示",
      presentationTitle: "展示模式",
      presentation: {
        flatWithBadges: "扁平列表（带服务器徽标）",
        groupedByServer: "按服务器分组",
      },
    },
  },

  sessionTags: {
    searchOrAddPlaceholder: "搜索或添加标签",
    editTagsLabel: "编辑标签",
    noTagsFound: "未找到标签",
    newTagItem: "新建标签…",
    newTagTitle: "新建标签",
    newTagMessage: "请输入新标签名称。",
    newTagConfirm: "添加",
  },

  sessionsList: {
    serverHeader: ({ server }: { server: string }) => `服务器：${server}`,
  },

  sessionInfo: {
    // Used by Session Info screen (app/(app)/session/[id]/info.tsx)
    killSession: "终止会话",
    killSessionConfirm: "您确定要终止此会话吗？",
    stopSession: "停止会话",
    stopSessionConfirm: "您确定要停止此会话吗？",
    archiveSession: "归档会话",
    archiveSessionConfirm: "您确定要归档此会话吗？",
    happySessionIdCopied: "Happier 会话 ID 已复制到剪贴板",
    failedToCopySessionId: "复制 Happier 会话 ID 失败",
    happySessionId: "Happier 会话 ID",
    claudeCodeSessionId: "Claude Code 会话 ID",
    claudeCodeSessionIdCopied: "Claude Code 会话 ID 已复制到剪贴板",
    aiProfile: "AI 配置文件",
    aiProvider: "AI 提供商",
    failedToCopyClaudeCodeSessionId: "复制 Claude Code 会话 ID 失败",
    codexSessionId: "Codex 会话 ID",
    codexSessionIdCopied: "Codex 会话 ID 已复制到剪贴板",
    failedToCopyCodexSessionId: "复制 Codex 会话 ID 失败",
    opencodeSessionId: "OpenCode 会话 ID",
    opencodeSessionIdCopied: "OpenCode 会话 ID 已复制到剪贴板",
    geminiSessionId: "Gemini 会话 ID",
    geminiSessionIdCopied: "Gemini 会话 ID 已复制到剪贴板",
    auggieSessionId: "Auggie 会话 ID",
    auggieSessionIdCopied: "Auggie 会话 ID 已复制到剪贴板",
    qwenSessionId: "Qwen Code 会话 ID",
    qwenSessionIdCopied: "Qwen Code 会话 ID 已复制到剪贴板",
    kimiSessionId: "Kimi 会话 ID",
    kimiSessionIdCopied: "Kimi 会话 ID 已复制到剪贴板",
    kiloSessionId: "Kilo 会话 ID",
    kiloSessionIdCopied: "Kilo 会话 ID 已复制到剪贴板",
    piSessionId: "Pi 会话 ID",
    piSessionIdCopied: "Pi 会话 ID 已复制到剪贴板",
    copilotSessionId: "Copilot 会话 ID",
    copilotSessionIdCopied: "Copilot 会话 ID 已复制到剪贴板",
    metadataCopied: "元数据已复制到剪贴板",
    failedToCopyMetadata: "复制元数据失败",
    failedToKillSession: "终止会话失败",
    failedToStopSession: "停止会话失败",
    failedToArchiveSession: "归档会话失败",
    connectionStatus: "连接状态",
    created: "创建时间",
    lastUpdated: "最后更新",
    sequence: "序列",
    quickActions: "快速操作",
    executionRunsSubtitle: "查看此会话的运行",
    automationsTitle: "自动化",
    automationsSubtitle: "管理此会话的计划消息",
    viewSessionLogTitle: "查看会话日志",
    viewSessionLogSubtitle: "打开此会话的实时日志尾部",
    pinSession: "置顶会话",
    unpinSession: "取消置顶",
    copyResumeCommand: "复制恢复命令",
    resumeCommand: ({ sessionId }: { sessionId: string }) => `happier resume ${sessionId}`,
    viewMachine: "查看设备",
    viewMachineSubtitle: "查看设备详情和会话",
    killSessionSubtitle: "立即终止会话",
    stopSessionSubtitle: "停止会话进程",
    archiveSessionSubtitle: "将此会话移至已归档",
    archivedSessions: "已归档会话",
    unarchiveSession: "取消归档会话",
    unarchiveSessionConfirm: "您确定要取消归档此会话吗？",
    unarchiveSessionSubtitle: "将此会话移回到非活动",
    failedToUnarchiveSession: "取消归档会话失败",
    metadata: "元数据",
    host: "主机",
    path: "路径",
    operatingSystem: "操作系统",
    processId: "进程 ID",
    happyHome: "Happier 主目录",
    attachFromTerminal: "从终端附加",
    tmuxTarget: "tmux 目标",
    tmuxFallback: "tmux 回退",
    copyMetadata: "复制元数据",
    agentState: "Agent 状态",
    rawJsonDevMode: "原始 JSON（开发者模式）",
    sessionStatus: "会话状态",
    fullSessionObject: "完整会话对象",
    controlledByUser: "用户控制",
    pendingRequests: "待处理请求",
    activity: "活动",
    thinking: "思考中",
    thinkingSince: "思考开始时间",
    thinkingLevel: "思考级别",
    cliVersion: "CLI 版本",
    cliVersionOutdated: "需要更新 CLI",
    cliVersionOutdatedMessage: ({
      currentVersion,
      requiredVersion,
    }: {
      currentVersion: string;
      requiredVersion: string;
    }) =>
      `已安装版本 ${currentVersion}。请更新到 ${requiredVersion} 或更高版本`,
    updateCliInstructions: "请运行 npm install -g @happier-dev/cli@latest",
    deleteSession: "删除会话",
    deleteSessionSubtitle: "永久删除此会话",
    deleteSessionConfirm: "永久删除会话？",
    deleteSessionWarning:
      "此操作无法撤销。与此会话相关的所有消息和数据将被永久删除。",
    failedToDeleteSession: "删除会话失败",
    sessionDeleted: "会话删除成功",
    manageSharing: "管理共享",
    manageSharingSubtitle: "与好友共享此会话或创建公开链接",
    renameSession: "重命名会话",
    renameSessionSubtitle: "更改此会话的显示名称",
    renameSessionPlaceholder: "输入会话名称...",
    forkSession: "分叉会话",
    forkSessionSubtitle: "从最新上下文创建新会话",
    failedToRenameSession: "重命名会话失败",
    sessionRenamed: "会话重命名成功",
  },

  components: {
    emptyMainScreen: {
      // Used by SessionGettingStartedGuidance component
      readyToCode: "准备开始编程？",
      installCli: "安装 Happier CLI",
      runIt: "运行它",
      scanQrCode: "扫描二维码",
      openCamera: "打开相机",
      installCommand: "$ npm i -g @happier-dev/cli",
      runCommand: "$ happier",
    },
    emptyMessages: {
      noMessagesYet: "暂无消息",
      created: ({ time }: { time: string }) => `创建于 ${time}`,
    },
    emptySessionsTablet: {
      noActiveSessions: "没有活动会话",
      startNewSessionDescription: "在任意已连接设备上开始新的会话。",
      startNewSessionButton: "开始新会话",
      openTerminalToStart: "在电脑上打开新的终端以开始会话。",
    },
  },

  zen: {
    title: "Zen",
    add: {
      placeholder: "需要做什么？",
    },
    home: {
      noTasksYet: "还没有任务。点按 + 添加一个。",
    },
    view: {
      workOnTask: "处理任务",
      clarify: "澄清",
      delete: "删除",
      linkedSessions: "已关联的会话",
      tapTaskTextToEdit: "点击任务文本以编辑",
    },
  },

  agentInput: {
    dropToAttach: "拖放以附加文件",
    envVars: {
      title: "环境变量",
      titleWithCount: ({ count }: { count: number }) => `环境变量 (${count})`,
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
      title: "权限模式",
      effectiveLabel: ({ label }: { label: string }) => `生效：${label}`,
      default: "默认",
      readOnly: "只读",
      acceptEdits: "接受编辑",
      safeYolo: "安全 YOLO",
      yolo: "YOLO",
      plan: "计划模式",
      bypassPermissions: "Yolo 模式",
      badgeAccept: "接受",
      badgePlan: "计划",
      badgeReadOnly: "只读",
      badgeSafeYolo: "安全 YOLO",
      badgeYolo: "YOLO",
      badgeAcceptAllEdits: "接受所有编辑",
      badgeBypassAllPermissions: "绕过所有权限",
      badgePlanMode: "计划模式",
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
      on: "已开启索引",
      off: "已关闭索引",
    },
    model: {
      title: "模型",
      useCliSettings: "使用 CLI 设置",
      configureInCli: "在 CLI 设置中配置模型",
      customDescription: "使用列表中未显示的模型 id。",
      customPromptBody: "输入模型 id",
      customPlaceholder: "例如 claude-3.5-sonnet",
    },
    codexPermissionMode: {
      title: "CODEX 权限模式",
      default: "CLI 设置",
      plan: "计划模式",
      readOnly: "只读模式",
      safeYolo: "安全 YOLO",
      yolo: "YOLO",
      badgePlan: "计划",
      badgeReadOnly: "只读",
      badgeSafeYolo: "安全 YOLO",
      badgeYolo: "YOLO",
    },
    codexModel: {
      title: "CODEX 模型",
      gpt5CodexLow: "gpt-5-codex 低",
      gpt5CodexMedium: "gpt-5-codex 中",
      gpt5CodexHigh: "gpt-5-codex 高",
      gpt5Minimal: "GPT-5 最小",
      gpt5Low: "GPT-5 低",
      gpt5Medium: "GPT-5 中",
      gpt5High: "GPT-5 高",
    },
    geminiPermissionMode: {
      title: "GEMINI 权限模式",
      default: "默认",
      readOnly: "只读",
      safeYolo: "安全 YOLO",
      yolo: "YOLO",
      badgeReadOnly: "只读",
      badgeSafeYolo: "安全 YOLO",
      badgeYolo: "YOLO",
    },
    geminiModel: {
      title: "GEMINI 模型",
      gemini25Pro: {
        label: "Gemini 2.5 Pro",
        description: "最强能力",
      },
      gemini25Flash: {
        label: "Gemini 2.5 Flash",
        description: "快速且高效",
      },
      gemini25FlashLite: {
        label: "Gemini 2.5 Flash Lite",
        description: "最快",
      },
    },
    context: {
      remaining: ({ percent }: { percent: number }) => `剩余 ${percent}%`,
    },
    suggestion: {
      fileLabel: "文件",
      folderLabel: "文件夹",
    },
    mode: {
      sectionTitle: "模式",
      badge: ({ name }: { name: string }) => `模式：${name}`,
      badgePending: ({ name }: { name: string }) => `模式：${name}（待处理）`,
      badgeA11y: ({ name }: { name: string }) => `模式：${name}`,
      refreshModesA11y: "刷新模式",
      pendingSwitching: ({ from, to }: { from: string; to: string }) =>
        `待处理：从 ${from} 切换到 ${to}`,
      currentMode: ({ name }: { name: string }) => `当前：${name}`,
      loadingModes: "正在加载模式…",
      refreshingModes: "正在刷新模式…",
      useDefaultModeHint: "使用此代理的默认模式。",
      startIn: ({ name }: { name: string }) => `开始于：${name}`,
      build: "构建",
      buildDescription: "默认行为",
      plan: "计划",
      planDescription: "先思考",
    },
    acp: {
      modeSectionTitle: "模式",
      refreshModesA11y: "刷新模式",
      pendingSwitching: ({ from, to }: { from: string; to: string }) =>
        `待处理：从 ${from} 切换到 ${to}`,
      currentMode: ({ name }: { name: string }) => `当前：${name}`,
      loadingModes: "正在加载模式…",
      refreshingModes: "正在刷新模式…",
      useDefaultModeHint: "使用此代理的默认模式。",
      startIn: ({ name }: { name: string }) => `开始于：${name}`,
      optionsSectionTitle: "选项",
      currentValue: ({ value }: { value: string }) => `当前：${value}`,
      pendingValue: ({
        current,
        requested,
      }: {
        current: string;
        requested: string;
      }) => `待处理：${current} → ${requested}`,
    },
    actionMenu: {
      title: "操作",
      files: "文件",
      stop: "停止",
    },
    noMachinesAvailable: "无设备",
  },

  machineLauncher: {
    showLess: "显示更少",
    showAll: ({ count }: { count: number }) => `显示全部 (${count} 个路径)`,
    enterCustomPath: "输入自定义路径",
    offlineUnableToSpawn: "无法生成新会话，已离线",
  },

  sidebar: {
    sessionsTitle: "Happier",
  },

  toolView: {
    open: "打开详情",
    expand: "展开/折叠",
    input: "输入",
    output: "输出",
  },

  tools: {
    common: {
      more: ({ count }: { count: number }) => `+${count} 更多`,
      elapsedSeconds: ({ seconds }: { seconds: string }) => `${seconds}s`,
      unknownToolTitle: "工具",
    },
    bashView: {
      commandDiffTitle: "原始命令",
      commandDiffHint:
        "命令预览会隐藏一小段用于清理环境的前缀，以便更易阅读。完整的原始命令如下所示。",
    },
    webFetch: {
      httpStatus: ({ status }: { status: number }) => `HTTP ${status}`,
    },
    fullView: {
      description: "描述",
      inputParams: "输入参数",
      output: "输出",
      error: "错误",
      completed: "工具已成功完成",
      noOutput: "未产生输出",
      running: "工具正在运行...",
      debug: "调试",
      show: "显示",
      hide: "隐藏",
      rawJsonDevMode: "原始 JSON（开发模式）",
    },
    taskView: {
      initializing: "正在初始化 agent...",
      moreTools: ({ count }: { count: number }) =>
        `+${count} 个更多${plural({ count, singular: "工具", plural: "工具" })}`,
    },
    subAgentRunView: {
      planTitle: "计划",
      delegateTitle: "委派",
      reviewDigestTitle: "审查摘要",
    },
    changeTitleView: {
      titleLabel: "标题",
    },
    enterPlanMode: {
      title: "已进入计划模式",
      body:
        "代理现在会在采取行动前提供结构化计划。准备好后，你可以退出计划模式或请求修改。",
    },
    structuredResult: {
      exit: "退出码",
      stdout: "标准输出",
      stderr: "标准错误",
      diff: "差异",
      result: "结果",
      items: "条目",
      more: ({ count }: { count: number }) => `+${count} 更多`,
    },
    workspaceIndexingPermission: {
      defaultTitle: "工作区索引",
      description:
        "索引可帮助代理更快地搜索你的代码库并提供更准确的答案。这可能会扫描工作区中的文件。",
      optionFallback: "选项",
      chooseOptionHint: "请选择下面的选项以继续。",
    },
    acpHistoryImport: {
      title: "导入会话历史记录？",
      defaultNote:
        "此会话历史记录与 Happier 中已有内容不同。导入可能会产生重复项。",
      counts: {
        local: ({ count }: { count: number }) => `本地：${count}`,
        remote: ({ count }: { count: number }) => `远程：${count}`,
      },
      preview: {
        localTail: "本地（末尾）",
        remoteTail: "远程（末尾）",
        unknownRole: "未知",
      },
      actions: {
        import: "导入",
        skip: "跳过",
      },
    },
    multiEdit: {
      editNumber: ({ index, total }: { index: number; total: number }) =>
        `编辑 ${index}/${total}`,
      replaceAll: "全部替换",
      summaryEdits: ({ count }: { count: number }) => `${count} 次编辑`,
    },
    names: {
      task: "任务",
      terminal: "终端",
      searchFiles: "搜索文件",
      search: "搜索",
      searchContent: "搜索内容",
      listFiles: "列出文件",
      planProposal: "计划建议",
      readFile: "读取文件",
      editFile: "编辑文件",
      writeFile: "写入文件",
      fetchUrl: "获取 URL",
      readNotebook: "读取 Notebook",
      editNotebook: "编辑 Notebook",
      todoList: "待办列表",
      webSearch: "Web 搜索",
      reasoning: "推理",
      applyChanges: "更新文件",
      viewDiff: "差异",
      turnDiff: "回合差异",
      question: "问题",
      changeTitle: "更改标题",
    },
    geminiExecute: {
      cwd: ({ cwd }: { cwd: string }) => `📁 ${cwd}`,
    },
    desc: {
      terminalCmd: ({ cmd }: { cmd: string }) => `终端(命令: ${cmd})`,
      searchPattern: ({ pattern }: { pattern: string }) =>
        `搜索(模式: ${pattern})`,
      searchPath: ({ basename }: { basename: string }) =>
        `搜索(路径: ${basename})`,
      fetchUrlHost: ({ host }: { host: string }) => `获取 URL(网址: ${host})`,
      editNotebookMode: ({ path, mode }: { path: string; mode: string }) =>
        `编辑 Notebook(文件: ${path}, 模式: ${mode})`,
      todoListCount: ({ count }: { count: number }) =>
        `待办列表(数量: ${count})`,
      webSearchQuery: ({ query }: { query: string }) =>
        `Web 搜索(查询: ${query})`,
      grepPattern: ({ pattern }: { pattern: string }) =>
        `grep(模式: ${pattern})`,
      multiEditEdits: ({ path, count }: { path: string; count: number }) =>
        `${path} (${count} 处编辑)`,
      readingFile: ({ file }: { file: string }) => `正在读取 ${file}`,
      writingFile: ({ file }: { file: string }) => `正在写入 ${file}`,
      modifyingFile: ({ file }: { file: string }) => `正在修改 ${file}`,
      modifyingFiles: ({ count }: { count: number }) =>
        `正在修改 ${count} 个文件`,
      modifyingMultipleFiles: ({
        file,
        count,
      }: {
        file: string;
        count: number;
      }) => `${file} 和其他 ${count} 个`,
      showingDiff: "显示更改",
    },
    askUserQuestion: {
      submit: "提交答案",
      multipleQuestions: ({ count }: { count: number }) => `${count} 个问题`,
      other: "其他",
      otherDescription: "输入您自己的答案",
      otherPlaceholder: "输入您的答案...",
    },
    exitPlanMode: {
      approve: "批准计划",
      reject: "拒绝",
      requestChanges: "请求修改",
      planMissing:
        "未提供计划文本。请查看上方消息中的计划，或请代理在审批请求中包含计划文本。",
      requestChangesPlaceholder: "告诉 Claude 你希望如何修改这个计划…",
      requestChangesSend: "发送反馈",
      requestChangesEmpty: "请填写你希望修改的内容。",
      requestChangesFailed: "请求修改失败，请重试。",
      responded: "已发送回复",
      approvalMessage: "我批准这个计划。请继续实现。",
      rejectionMessage: "我不批准这个计划。请修改它，或问我希望做哪些更改。",
    },
  },

  files: {
    searchPlaceholder: "搜索文件...",
    clearSearchA11y: "清除搜索",
    createFileA11y: "创建文件",
    createFolderA11y: "创建文件夹",
    createFilePromptTitle: "创建文件",
    createFilePromptBody: "请输入相对于项目根目录的路径。",
    createFileInvalidPath:
      "文件路径无效。请使用工作区内的相对路径，例如 src/new-file.ts。",
    createFileFailed: "创建文件失败。",
    createFolderPromptTitle: "创建文件夹",
    createFolderPromptBody: "请输入相对于项目根目录的文件夹路径。",
    createFolderInvalidPath:
      "文件夹路径无效。请使用工作区内的相对路径，例如 src/new-folder。",
    createFolderFailed: "创建文件夹失败。",
    changeRow: {
      viewDiffA11y: ({ file }: { file: string }) => `查看 ${file} 的差异`,
      status: {
        untracked: "未跟踪文件",
        added: "新文件",
        deleted: "已删除文件",
        renamed: "已重命名文件",
        copied: "已复制文件",
        conflicted: "冲突文件",
        modified: "已修改文件",
      },
    },
    projectLinkPicker: {
      title: "链接项目文件",
      searchFailed: "搜索失败。请重试。",
    },
    detachedHead: "游离 HEAD",
    summary: ({ staged, unstaged }: { staged: number; unstaged: number }) =>
      `${staged} 已暂存 • ${unstaged} 未暂存`,
    branchSummary: {
      ahead: "领先",
      behind: "落后",
      included: "已包含",
      staged: "已暂存",
      pending: "待处理",
      unstaged: "未暂存",
      upstreamLabel: ({ upstream }: { upstream: string }) => `上游 ${upstream}`,
      noUpstream: "无上游",
    },
    stageActions: {
      selectPendingDiffMode: "选择“待处理”差异模式以选择要提交的行。",
      unableToBuildPatchFromSelection: "无法根据所选行构建补丁。",
      diffChangedRefreshAndReselect: "差异已变化，请刷新并重新选择行。",
    },
    discardChangesFor: ({ path }: { path: string }) => `放弃 ${path} 的更改`,
    commitSelection: {
      addToCommit: "加入提交",
      removeFromCommit: "从提交中移除",
    },
    sourceControlStatus: {
      changedFilesLabel: ({ count }: { count: number }) => `${count} 个文件`,
    },
    repositoryChangedFiles: ({ count }: { count: number }) =>
      `仓库变更文件（${count}）`,
    sessionAttributedChanges: ({ count }: { count: number }) =>
      `会话归因的变更（${count}）`,
    otherRepositoryChanges: ({ count }: { count: number }) =>
      `其他仓库变更（${count}）`,
    attributionReliabilityHigh:
      "归因尽力而为。仓库视图仍是最终依据。",
    attributionReliabilityLimited:
      "可靠性有限：此仓库有多个会话处于活动状态。仅显示直接归因。",
    attributionLegendFull:
      "direct = 来自本会话操作，inferred = 基于快照的归因",
    attributionLegendDirectOnly: "direct = 来自本会话操作",
    inferredSuppressed: ({ count }: { count: number }) =>
      `已有 ${count} 个推断文件保留在仅仓库变更中。`,
    noSessionAttributedChanges:
      "当前未检测到会话归因的变更。",
    notRepo: "不是版本控制仓库",
    notUnderSourceControl: "此目录不在版本控制下",
    searching: "正在搜索文件...",
      noFilesFound: "未找到文件",
      noFilesInProject: "项目中没有文件",
      repositoryFolderLoadFailed: "无法加载文件夹",
      repositoryCollapseAll: "全部折叠",
    sourceControlOperationsLog: {
      title: "最近的版本控制操作",
      allSessions: "所有会话",
      thisSession: "此会话",
      emptyThisSession: "此会话没有最近的操作。",
    },
    operationsHistory: {
      recentCommits: "最近提交",
      noCommitsAvailable: "暂无可用提交。",
      loadMore: "加载更多提交",
    },
      reviewFilterPlaceholder: "筛选文件...",
      reviewNoMatches: "无匹配项",
      reviewLargeDiffOneAtATime: "检测到较大的 diff；将随滚动加载差异内容。",
      reviewDiffRequestFailed: "无法加载 diff",
      reviewUnableToLoadDiff: "无法加载 diff",
      tryDifferentTerm: "尝试不同的搜索词",
      searchResults: ({ count }: { count: number }) => `搜索结果 (${count})`,
      projectRoot: "项目根目录",
    stagedChanges: ({ count }: { count: number }) => `已暂存的更改 (${count})`,
      unstagedChanges: ({ count }: { count: number }) =>
        `未暂存的更改 (${count})`,
      // File viewer strings
      fileReadFailed: "读取文件失败",
      fileWriteFailed: "写入文件失败",
      fileEditor: {
        experimentalHint:
          "编辑功能为实验性。保存以将更改写回会话 worktree。",
      },
      fileEditingUnsupported:
        "连接的守护进程不支持文件编辑。请在该机器上更新 Happier 以启用写入操作。",
      selectionFailed: "更新选择失败",
      openReviewCommentsFailed: "打开审阅评论失败",
        reviewComments: {
          title: ({ count }: { count: number }) => `审阅评论（${count}）`,
          placeholder: "添加审查评论…",
          jump: "跳转",
          addCommentA11y: "添加评论",
          closeCommentA11y: "关闭评论",
          draftsChipLabel: ({ count }: { count: number }) => `审阅（${count}）`,
          errors: {
            empty: "评论不能为空",
            couldNotMapSelection: "无法将选择映射到差异行",
          },
        },
        commitDetails: {
          missingContext: "缺少提交上下文",
          failedToLoadDiff: "加载提交差异失败",
          diffUnavailableTitle: "提交差异不可用",
          diffUnavailableHint: "请从“文件”页面重新打开该提交。",
          commitLabel: "提交",
          running: ({ operation }: { operation: string }) => `运行中：${operation}`,
          revert: {
            title: "回退提交",
            button: "回退提交",
            confirm: "回退",
            success: "提交已成功回退",
            failed: "回退提交失败",
          },
        },
        commitRevertUnavailable: "此提交无法回滚。",
        commitMessageEditor: {
          placeholder: "提交信息",
          generate: "生成",
          generating: "正在生成…",
          applySuggestion: "应用建议",
          commit: "提交",
          generateFailed: "生成提交信息失败",
          generatorDisabled: "提交信息生成器已禁用",
        },
      loadingFile: ({ fileName }: { fileName: string }) =>
        `正在加载 ${fileName}...`,
        binaryFile: "二进制文件",
        imagePreviewTooLarge: "图片预览过大，无法显示",
        cannotDisplayBinary: "无法显示二进制文件内容",
        diff: "差异",
      file: "文件",
    diffModes: {
      pending: "待处理",
      included: "已包含",
      combined: "合并",
    },
    fileActions: {
      selectForCommit: "选择用于提交",
      stageFile: "暂存文件",
      removeFromSelection: "从选择中移除",
      unstageFile: "取消暂存",
      selectionHint: "选择“已包含”或“待处理”以启用行选择。",
      selectedLines: {
        selectLinesForCommit: "选择行用于提交",
        stageSelectedLines: "暂存所选行",
        unstageSelectedLines: "取消暂存所选行",
      },
      clearSelection: "清除选择",
    },
    toolbar: {
      changedFiles: "更改的文件",
      allRepositoryFiles: "仓库中的所有文件",
      repositoryView: "仓库视图",
      sessionView: "会话视图",
      review: "审阅",
      list: "列表",
      scm: "Git",
    },
    fileEmpty: "文件为空",
    noChanges: "没有要显示的更改",
    sourceControlOperations: {
      title: "版本控制",
      actorThisSession: "本会话",
      actorSession: ({ sessionIdPrefix }: { sessionIdPrefix: string }) =>
        `会话 ${sessionIdPrefix}`,
      running: ({ operation, actor }: { operation: string; actor: string }) =>
        `运行中：${operation} · ${actor}`,
      lockedBy: ({ actor }: { actor: string }) =>
        `版本控制操作已被 ${actor} 锁定。`,
      globalLock: "操作暂时被锁定，因为另一个会话正在运行版本控制命令。",
      selection: ({ count }: { count: number }) =>
        count === 1
          ? "已选择 1 个文件用于下一次提交。"
          : `已选择 ${count} 个文件用于下一次提交。`,
      clear: "清除",
      conflictsDetected:
        "检测到冲突。在冲突解决之前，提交、拉取和推送将被阻止。",
      actions: {
        fetch: "获取",
        pull: "拉取",
        push: "推送",
      },
      blockedHints: {
        lock: "锁定",
        commitBlocked: "提交被阻止",
        pullBlocked: "拉取被阻止",
        pushBlocked: "推送被阻止",
      },
    },
  },

  executionRuns: {
    newRun: {
      headerTitle: "开始运行",
      sections: {
        intent: "意图",
        permissions: "权限",
        backends: "后端",
        instructions: "指令",
      },
      intents: {
        review: "审阅",
        plan: "计划",
        delegate: "委派",
      },
      permissionModes: {
        readOnly: "只读",
        default: "默认",
      },
      instructionsPlaceholder: "子代理应该做什么？",
      actions: {
        start: "开始",
      },
      guidancePreview: "指导预览",
      a11y: {
        startRun: "开始运行",
        cancel: "取消",
        selectIntent: ({ intent }: { intent: string }) => `选择意图 ${intent}`,
        selectPermissionMode: ({ mode }: { mode: string }) => `选择权限 ${mode}`,
        toggleBackend: ({ backendId }: { backendId: string }) => `切换后端 ${backendId}`,
      },
    },
    details: {
      labels: {
        intent: "意图",
        backendId: "后端 ID",
        permissionMode: "权限模式",
        retentionPolicy: "保留策略",
        runClass: "运行类别",
        ioMode: "I/O 模式",
      },
      timestamps: {
        started: "开始",
        finished: "完成",
      },
    },
  },

  settingsSession: {
    messageSending: {
      title: "消息发送",
      footer:
        "控制在代理运行时你发送消息会发生什么。",
      queueInAgentTitle: "加入代理队列（当前）",
      queueInAgentSubtitle:
        "立即写入对话记录；代理准备好后再处理。",
      interruptTitle: "中断并发送",
      interruptSubtitle: "终止当前回合，然后立即发送。",
      pendingTitle: "等待就绪（待发送）",
      pendingSubtitle:
        "将消息保留在待发送队列；代理就绪后会拉取。",
      busySteerPolicyTitle: "代理忙碌时（支持引导）",
      busySteerPolicyFooter:
        "如果代理支持进行中引导，请选择消息是立即引导还是先进入待发送。",
      busySteerPolicy: {
        steerImmediatelyTitle: "立即引导",
        steerImmediatelySubtitle:
          "立刻发送并引导当前回合（不中断）。",
        queueForReviewTitle: "加入待发送",
        queueForReviewSubtitle:
          "先放入待发送；稍后使用“立即引导”发送。",
      },
    },
    thinking: {
      title: "思考",
      footer:
        "控制代理的思考消息如何显示在会话记录中。",
      displayModeTitle: "思考显示",
      displayMode: {
        inlineSummaryTitle: "内联（摘要）",
        inlineSummarySubtitle: "显示一行摘要；点击展开。",
        inlineTitle: "内联（完整）",
        inlineSubtitle: "在会话记录中直接显示完整思考内容。",
        toolTitle: "工具卡片",
        toolSubtitle: "将思考消息显示为“推理”工具卡片。",
        hiddenTitle: "隐藏",
        hiddenSubtitle: "从会话记录中隐藏思考消息。",
      },
      inlineChromeTitle: "思考卡片",
      inlineChromeSubtitle: "为内联思考行显示一个轻微的卡片背景。",
    },
    toolRendering: {
      title: "工具渲染",
      footer:
        "控制会话时间线中显示多少工具细节。这是 UI 偏好设置，不会改变代理行为。",
      defaultToolDetailLevelTitle: "默认工具细节级别",
      expandedToolDetailLevelTitle: "展开工具细节级别",
      cardTapActionTitle: "点击动作（卡片）",
      timelineChrome: {
        title: "时间线工具样式",
        cardsTitle: "卡片",
        cardsSubtitle: "带内联内容的工具卡片（取决于细节级别）。",
        activityFeedTitle: "活动动态",
        activityFeedSubtitle: "为高工具密度优化的紧凑行。",
      },
      cardDensity: {
        title: "卡片密度",
        comfortableTitle: "舒适",
        comfortableSubtitle: "更大的间距与更清晰的分隔。",
        compactTitle: "紧凑",
        compactSubtitle: "更紧凑的标题与更小的内边距。",
      },
      activityFeed: {
        defaultDetailTitle: "活动动态默认细节",
        expandedDetailTitle: "活动动态展开细节",
        tapActionTitle: "点击动作（活动动态）",
        tapAction: {
          expandTitle: "展开",
          expandSubtitle: "点击展开或折叠内联细节。",
          openTitle: "打开",
          openSubtitle: "点击打开完整工具视图屏幕。",
        },
        defaultExpandedTitle: "默认展开",
        defaultExpandedSubtitle: "在活动动态中默认展开工具行。",
      },
      localControlDefaultTitle: "本地控制默认值",
      showDebugByDefaultTitle: "默认显示调试信息",
      showDebugByDefaultSubtitle:
        "在完整工具视图中自动展开原始工具负载。",
    },
    transcript: {
      title: "会话记录",
      entrySubtitle: "打开会话记录设置",
      footer: "自定义聊天显示方式与会话记录行为。",
      layoutTitle: "布局",
      layoutFooter: "在简单线性记录与按回合分组之间选择。",
      layoutPickerTitle: "会话记录布局",
      layout: {
        linearTitle: "线性（当前）",
        linearSubtitle: "以平铺列表显示消息。",
        turnsTitle: "回合",
        turnsSubtitle: "将消息按用户/助手回合分组。",
      },
      activityGroupTitle: "将工具分组到「活动」",
      activityGroupSubtitle: "在每个回合内将工具调用压缩为「活动」部分。",
      toolAppearanceTitle: "工具外观",
      toolAppearanceSubtitle: "自定义会话记录中的工具显示样式。",
      motionTitle: "动效",
      motionFooter: "控制会话记录中的动画。",
      motionPickerTitle: "动画",
      motion: {
        offTitle: "关闭",
        offSubtitle: "禁用会话记录动画。",
        subtleTitle: "轻微（默认）",
        subtleSubtitle: "为新活动提供快速、最小的动效。",
        fullTitle: "完整",
        fullSubtitle: "更具表现力的动效与过渡。",
      },
      advancedMotionTitle: "高级动效…",
      advancedMotionSubtitle: "微调新鲜度窗口与动画开关。",
      scrollTitle: "滚动",
      scrollFooter: "控制底部固定滚动与跳到底部行为。",
        scrollPinTitle: "固定到底部",
        scrollPinSubtitle: "当你在底部时跟随新消息。",
        jumpToBottomTitle: "跳到底部按钮",
        jumpToBottomButtonLabel: "跳到底部",
        jumpToBottomSubtitle: "当你向上滚动且有新活动到达时显示按钮。",
        advancedScrollTitle: "高级滚动…",
      advancedScrollSubtitle: "微调固定阈值与计数。",
      advancedTitle: "高级…",
      advancedSubtitle: "性能与调试控制。",
      advanced: {
        turnGroupingTitle: "回合分组",
        turnGroupingFooter: "控制每个回合中「活动」如何形成。",
        performanceTitle: "性能",
        performanceFooter: "流式更新与列表的性能控制。",
        coalesceEnabledTitle: "合并流式更新",
        coalesceEnabledSubtitle: "合并 socket 更新以保持滚动流畅。",
        coalesceWindowTitle: "合并窗口",
        coalesceWindowSubtitle: ({ value }: { value: string }) => `当前：${value}ms`,
        coalesceWindowPromptTitle: "合并窗口（ms）",
        coalesceWindowPromptBody: "设置缓存的流式更新多久刷新到 store。",
        coalesceMaxBatchTitle: "最大批大小",
        coalesceMaxBatchSubtitle: ({ value }: { value: string }) => `当前：${value}`,
        coalesceMaxBatchPromptTitle: "最大批大小",
        coalesceMaxBatchPromptBody: "设置单次刷新中应用的消息上限。",
        thinkingPulseStaleTitle: "思考过期窗口",
        thinkingPulseStaleSubtitle: ({ value }: { value: string }) => `当前：${value}ms`,
        thinkingPulseStalePromptTitle: "思考过期窗口（ms）",
        thinkingPulseStalePromptBody: "在没有更新超过该时间后隐藏活跃思考。",
        listImplementationTitle: "转录列表实现",
        listImplementationSubtitle: "切换列表引擎（调试）。",
        listImplementation: {
          flashTitle: "FlashList v2（推荐）",
          flashSubtitle: "长转录的最佳性能。",
          legacyTitle: "旧版 FlatList",
          legacySubtitle: "用于兼容性调试的备用方案。",
        },
        activityStrategyTitle: "活动分组策略",
        activityStrategy: {
          consecutiveTitle: "连续工具（默认）",
          consecutiveSubtitle: "只将连续的工具调用分组到活动中。",
          allToolsTitle: "回合内所有工具",
          allToolsSubtitle: "将回合内所有工具调用分组为一个活动部分。",
        },
        activityCollapsedPreviewCountTitle: "折叠预览",
        activityCollapsedPreviewCountSubtitle: ({ value }: { value: string }) => `当活动折叠时显示最近 ${value} 个工具。`,
        activityCollapsedPreviewCount: {
          offTitle: "关闭",
          offSubtitle: "仅显示活动标题。",
          oneTitle: "1 个工具",
          oneSubtitle: "显示最近的工具作为预览行。",
          twoTitle: "2 个工具",
          twoSubtitle: "显示最近 2 个工具作为预览行。",
          threeTitle: "3 个工具",
          threeSubtitle: "显示最近 3 个工具作为预览行。",
          countTitle: ({ value }: { value: string }) => `${value} 个工具`,
          countSubtitle: ({ value }: { value: string }) => `显示最近 ${value} 个工具作为预览行。`,
        },
        motionTitle: "动效（高级）",
        motionFooter: "动画受新鲜度限制，以保持历史稳定。",
        freshnessTitle: "新鲜度窗口",
        freshnessSubtitle: ({ value }: { value: string }) => `当前：${value}ms`,
        freshnessPromptTitle: "新鲜度窗口（ms）",
        freshnessPromptBody: "设置新项目被视为“新鲜”的持续时间。",
        animateNewItemsTitle: "为新项目添加动画",
        animateNewItemsSubtitle: "为流式新增的消息与工具添加动画。",
        animateToolExpandCollapseTitle: "动画展开/折叠工具",
        animateToolExpandCollapseSubtitle: "动画化内联展开/折叠过渡。",
        animateToolExpandCollapseFreshOnlyTitle: "仅对新鲜项展开/折叠动画",
        animateToolExpandCollapseFreshOnlySubtitle:
          "仅对新鲜工具的展开/折叠进行动画处理。",
        animateThinkingTitle: "动画思考",
        animateThinkingSubtitle: "在可见时为流式思考消息添加动画。",
        scrollTitle: "滚动（高级）",
        scrollFooter: "微调固定阈值与跳转行为。",
        pinOffsetTitle: "固定偏移阈值",
        pinOffsetSubtitle: ({ value }: { value: string }) => `当前：${value}px`,
        pinOffsetPromptTitle: "固定偏移阈值（px）",
        pinOffsetPromptBody: "设置距离底部多远仍算固定。",
        autoFollowTitle: "固定时自动跟随",
        autoFollowSubtitle: "固定时自动跟随新活动。",
        jumpMinNewCountTitle: "跳转按钮最小新数量",
        jumpMinNewCountSubtitle: ({ value }: { value: string }) => `当前：${value}`,
        jumpMinNewCountPromptTitle: "跳转按钮最小新数量",
        jumpMinNewCountPromptBody: "仅在达到此数量的新项目后显示跳转按钮。",
        jumpAnimateScrollTitle: "动画跳到底部",
        jumpAnimateScrollSubtitle: "跳到底部时动画滚动。",
      },
    },
    toolDetailOverrides: {
      title: "工具细节覆盖",
      entrySubtitle: "覆盖单个工具",
      footer:
        "为特定工具覆盖细节级别。覆盖在旧版归一化后应用于规范工具名（V2）。",
      expandedTitle: "展开细节覆盖",
      expandedFooter: "为特定工具覆盖展开时的细节级别。",
    },
    permissions: {
      title: "权限",
      entrySubtitle: "打开权限设置",
      footer:
        "配置默认权限以及更改如何应用到正在运行的会话。",
      promptSurfaceTitle: "权限提示",
      promptSurfaceFooter: "选择会话中权限审批提示出现的位置。",
      applyChangesFooter:
        "选择权限更改何时对正在运行的会话生效。",
      backendFooter:
        "设置使用此后端启动会话时的默认权限模式。",
      defaultPermissionModeTitle: "默认权限模式",
      promptSurface: {
        composerTitle: "靠近输入框（推荐）",
        composerSubtitle: "在输入框附近显示丰富的权限卡片。",
        transcriptTitle: "在会话记录中",
        transcriptSubtitle: "在工具消息内显示权限提示。",
        bothTitle: "两者",
        bothSubtitle: "在输入框附近与会话记录中同时显示。",
      },
      applyTiming: {
        immediateTitle: "立即应用",
        nextPromptTitle: "在下一条消息时应用",
      },
    },
    subAgentGuidanceEntry: {
      openSubtitle: "打开子代理设置",
    },
    actionsEntry: {
      footer:
        "按界面与位置（UI、语音、MCP）启用操作，并控制它们显示的位置。",
      openSubtitle: "打开操作设置",
    },
    defaultPermissions: {
      title: "默认权限",
      footer:
        "用于启动新会话。配置文件可选择覆盖。",
      applyPermissionChangesTitle: "应用权限更改",
      applyPermissionChangesImmediateSubtitle:
        "对正在运行的会话立即应用（更新会话元数据）。",
      applyPermissionChangesNextPromptSubtitle: "仅在下一条消息时应用。",
    },
    replayResume: {
      title: "回放恢复",
      footer:
        "当供应商恢复不可用时，可选择将最近的会话消息回放到新会话作为上下文。",
      enabledTitle: "启用回放恢复",
      enabledSubtitleOn:
        "当供应商恢复不可用时，提供回放式恢复。",
      enabledSubtitleOff: "不提供回放式恢复。",
      strategyTitle: "回放策略",
      strategy: {
        recentTitle: "最近消息",
        recentSubtitle: "仅使用最近的会话消息。",
        summaryRecentTitle: "摘要 + 最近（实验）",
        summaryRecentSubtitle:
          "包含简短摘要和最近消息（尽力而为）。",
      },
      recentMessagesTitle: "要包含的最近消息",
      recentMessagesPlaceholder: "16",
    },
    toolDetailLevel: {
      titleOnlyTitle: "仅标题",
      titleOnlySubtitle: "时间线中只显示工具名称（无副标题、无内容）。",
      compactTitle: "紧凑",
      compactSubtitle: "时间线中在同一行显示工具名称＋简短副标题（无内容）。",
      summaryTitle: "摘要",
      summarySubtitle: "时间线中显示精简且安全的摘要。",
      fullTitle: "完整",
      fullSubtitle: "时间线中内联显示完整细节。",
      defaultTitle: "默认",
      defaultSubtitle: "使用全局默认值。",
      styleDefaultTitle: "默认（推荐）",
      styleDefaultSubtitle: "卡片：摘要。活动动态：紧凑。",
      expandedStyleDefaultTitle: "默认（推荐）",
      expandedStyleDefaultSubtitle: "卡片：完整。活动动态：摘要。",
    },
    terminalConnect: {
      title: "终端连接",
      legacySecretExportTitle: "旧版密钥导出（兼容）",
      legacySecretExportEnabledSubtitle:
        "已启用：将旧版账号密钥导出到终端，以便旧版终端可以连接。不推荐。",
      legacySecretExportDisabledSubtitle:
        "已禁用（推荐）：只用内容密钥为终端配置（Terminal Connect V2）。",
    },
    sessionList: {
      title: "会话列表",
      footer: "自定义会话列表每行显示的内容。",
      tagsTitle: "会话标签",
      tagsEnabledSubtitle: "在会话列表中显示标签控件",
      tagsDisabledSubtitle: "隐藏标签控件",
    },
  },
  settingsVoice: {
    // Voice settings screen
    modeTitle: "语音",
    modeDescription:
      "配置语音功能。您可以完全关闭语音、使用 Happier Voice（需要订阅），或使用您自己的 ElevenLabs 账号。",
    mode: {
      off: "关闭",
      offSubtitle: "关闭所有语音功能",
      happier: "Happier Voice",
      happierSubtitle: "使用 Happier Voice（需要订阅）",
      local: "本地 OSS 语音",
      localSubtitle: "使用本地 OpenAI 兼容的 STT/TTS 端点",
      byo: "使用我的 ElevenLabs",
      byoSubtitle: "使用您自己的 ElevenLabs API 密钥和代理",
    },
    ui: {
      title: "语音界面",
      footer: "可选的语音事件屏幕活动流（不会写入会话）。",
      activityFeedEnabled: "启用语音活动流",
      activityFeedEnabledSubtitle: "使用语音时显示最近的语音事件",
      activityFeedAutoExpandOnStart: "开始时自动展开",
      activityFeedAutoExpandOnStartSubtitle: "语音开始时自动展开活动流",
      scopeTitle: "默认语音范围",
      scopeSubtitle: "选择默认将语音视为全局（账号）或会话范围。",
      scopeGlobal: "全局（账号）",
      scopeGlobalSubtitle: "导航时保持可见，并可切换目标会话",
      scopeSession: "会话",
      scopeSessionSubtitle: "在启动语音的会话中进行控制",
      surfaceLocationTitle: "显示位置",
      surfaceLocationSubtitle: "选择语音界面显示的位置。",
      surfaceLocation: {
        autoTitle: "自动",
        autoSubtitle: "全局范围显示在侧边栏；会话范围显示在会话内。",
        sidebarTitle: "侧边栏",
        sidebarSubtitle: "在侧边栏显示语音界面。",
        sessionTitle: "会话",
        sessionSubtitle: "在会话输入框上方显示语音界面。",
      },
      updates: {
        title: "会话更新",
        footer: "控制语音助手接收的后台上下文。",
        activeSessionTitle: "目标会话",
        activeSessionSubtitle: "对当前目标会话自动发送的内容。",
        otherSessionsTitle: "其他会话",
        otherSessionsSubtitle: "对非目标会话自动发送的内容。",
        level: {
          noneTitle: "无",
          noneSubtitle: "不发送自动更新。",
          activityTitle: "仅活动",
          activitySubtitle: "仅发送计数和时间戳。",
          summariesTitle: "摘要",
          summariesSubtitle: "发送简短安全摘要（不含原文）。",
          snippetsTitle: "片段",
          snippetsSubtitle: "发送短消息片段（有隐私风险）。",
        },
        snippetsMaxMessagesTitle: "片段最大消息数",
        snippetsMaxMessagesSubtitle: "限制每次更新包含的消息数量。",
        includeUserMessagesInSnippetsTitle: "包含你的消息",
        includeUserMessagesInSnippetsSubtitle: "启用后，片段可包含你的消息。",
        otherSessionsSnippetsModeTitle: "其他会话片段",
        otherSessionsSnippetsModeSubtitle: "控制何时允许其他会话的片段。",
        otherSessionsSnippetsMode: {
          neverTitle: "从不",
          neverSubtitle: "禁用其他会话片段。",
          onDemandTitle: "按需",
          onDemandSubtitle: "仅当用户明确要求时允许。",
          autoTitle: "自动",
          autoSubtitle: "允许自动发送其他会话片段（噪声较大）。",
        },
      },
    },
    byo: {
      title: "使用我的 ElevenLabs",
      agentReuseDialog: {
        title: "已存在 Happier 代理",
        messageWithId: ({ name, id }: { name: string; id: string }) =>
          `我们发现已有一个 ElevenLabs 代理（“${name}”，id: ${id}）。\n\n你想更新它还是创建一个新的？`,
        messageNoId: ({ name }: { name: string }) =>
          `我们发现已有一个 ElevenLabs 代理（“${name}”）。\n\n你想更新它还是创建一个新的？`,
      },
      configured: "已配置。语音使用量将计入您的 ElevenLabs 账号。",
      notConfigured:
        "输入您的 ElevenLabs API 密钥和代理 ID，即可在无需订阅的情况下使用语音。",
      createAccount: "创建 ElevenLabs 账号",
      createAccountSubtitle: "创建 API Key 前先注册（或登录）",
      openApiKeys: "打开 ElevenLabs API 密钥",
      openApiKeysSubtitle: "ElevenLabs → Developers → API Keys → Create API key",
      apiKeyHelp: "如何创建 API 密钥",
      apiKeyHelpSubtitle:
        "创建并复制 ElevenLabs API 密钥的分步说明",
      apiKeyHelpDialogTitle: "创建 ElevenLabs API 密钥",
      apiKeyHelpDialogBody:
        "Open ElevenLabs → Developers → API Keys → Create API key → Copy the key.",
      autoprovCreate: "创建 Happier 代理",
      autoprovCreateSubtitle:
        "使用您的 API 密钥在 ElevenLabs 账号中创建并配置 Happier 代理",
      autoprovUpdate: "更新代理",
      autoprovUpdateSubtitle: "将您的代理更新到最新的 Happier 模板",
      autoprovCreated: ({ agentId }: { agentId: string }) =>
        `已创建代理：${agentId}`,
      autoprovUpdated: "代理已更新",
      autoprovFailed: "创建/更新代理失败。请重试。",
      agentId: "代理 ID",
      agentIdSet: "已设置",
      agentIdNotSet: "未设置",
      agentIdTitle: "ElevenLabs 代理 ID",
      agentIdDescription: "输入您在 ElevenLabs 控制台中的代理 ID。",
      agentIdPlaceholder: "agent_...",
      apiKey: "API 密钥",
      apiKeySet: "已设置",
      apiKeyNotSet: "未设置",
      apiKeyTitle: "ElevenLabs API 密钥",
      apiKeyDescription:
        "输入您的 ElevenLabs API 密钥。此信息会在设备上加密存储。",
      apiKeyPlaceholder: "xi-api-key",
      voiceSearchPlaceholder: "搜索声音",
      speakerBoostTitle: "说话人增强",
      speakerBoostSubtitle: "提升清晰度和存在感（可选）。",
      speakerBoostAuto: "自动",
      speakerBoostAutoSubtitle: "使用 ElevenLabs 默认值。",
      speakerBoostOn: "开启",
      speakerBoostOnSubtitle: "强制开启说话人增强。",
      speakerBoostOff: "关闭",
      speakerBoostOffSubtitle: "强制关闭说话人增强。",
      voiceGroupTitle: "声音",
      voiceGroupFooter:
        "选择 ElevenLabs 代理的说话方式。更改会在更新代理后生效。",
      provisioningGroupTitle: "代理配置",
      provisioningGroupFooter:
        "如果你更改了声音/调校，请点击“更新代理”以在 ElevenLabs 中应用。",
      realtime: {
        call: {
          title: "通话",
          welcome: {
            title: "欢迎语",
            subtitle: "通话开始时的可选问候。",
            detail: {
              off: "关闭",
              immediate: "立即",
              onFirstTurn: "首次发言",
            },
            options: {
              offSubtitle: "不问候。",
              immediateSubtitle: "通话连接后立即问候。",
              onFirstTurnSubtitle: "在第一次回复开始时问候。",
            },
          },
        },
        voicePicker: {
          title: "声音",
          subtitle: "选择用于回复的 ElevenLabs 声音。",
          missingApiKeyTitle: "添加 API 密钥以加载声音",
          loadingTitle: "正在加载声音…",
          errorTitle: "加载声音失败",
          errorSubtitle: "检查 API 密钥后重试。",
        },
        modelPicker: {
          title: "模型",
          subtitle: "可选：覆盖 ElevenLabs TTS 模型 ID。",
          detailAuto: "自动",
          options: {
            autoTitle: "自动",
            autoSubtitle: "使用 ElevenLabs 默认模型。",
            multilingualV2Subtitle: "常见默认（多语言）。",
            turboV2Subtitle: "更低延迟（如你的套餐支持）。",
            turboV25Subtitle: "Turbo 2.5（如可用）。",
            customTitle: "自定义…",
            customSubtitle: "输入模型 ID。",
          },
          prompt: {
            title: "模型 ID",
            body: "输入 ElevenLabs 模型 ID，或留空以使用默认值。",
          },
        },
        voiceSettings: {
          default: "默认",
          stability: {
            title: "稳定度",
            subtitle: "0–1。留空使用默认值。",
            promptTitle: "稳定度（0–1）",
            promptBody: "输入 0 到 1 之间的数字。留空使用默认值。",
            invalid: "请输入 0 到 1 之间的数字。",
          },
          similarityBoost: {
            title: "相似度增强",
            subtitle: "0–1。留空使用默认值。",
            promptTitle: "相似度增强（0–1）",
            promptBody: "输入 0 到 1 之间的数字。留空使用默认值。",
            invalid: "请输入 0 到 1 之间的数字。",
          },
          style: {
            title: "风格",
            subtitle: "0–1。留空使用默认值。",
            promptTitle: "风格（0–1）",
            promptBody: "输入 0 到 1 之间的数字。留空使用默认值。",
            invalid: "请输入 0 到 1 之间的数字。",
          },
          speed: {
            title: "语速",
            subtitle: "0.5–2。留空使用默认值。",
            promptTitle: "语速（0.5–2）",
            promptBody: "输入 0.5 到 2 之间的数字。留空使用默认值。",
            invalid: "请输入 0.5 到 2 之间的数字。",
          },
        },
        getStartedTitle: "开始使用",
      },
      apiKeySaveFailed: "保存 API 密钥失败。请重试。",
      disconnect: "断开连接",
      disconnectSubtitle: "移除此设备上保存的 ElevenLabs 凭据",
      disconnectTitle: "断开 ElevenLabs 连接",
      disconnectDescription:
        "这将从此设备移除您已保存的 ElevenLabs API 密钥和代理 ID。",
      disconnectConfirm: "断开连接",
    },
    local: {
      title: "本地 OSS 语音",
      footer: "配置 OpenAI 兼容的语音转文字（STT）与文字转语音（TTS）端点。",
      localhostWarning:
        '注意："localhost" 和 "127.0.0.1" 通常无法在手机上使用。请使用电脑的局域网 IP 或隧道。',
      notSet: "未设置",
      apiKeySet: "已设置",
      apiKeyNotSet: "未设置",
      baseUrlPlaceholder: "http://192.168.1.10:8000/v1",
      apiKeyPlaceholder: "可选",
      apiKeySaveFailed: "保存 API 密钥失败。请重试。",
      googleCloudTts: {
        provider: {
          title: "Google Cloud 文字转语音",
          subtitle: "使用你自己的 Google Cloud API 密钥合成音频。",
          detail: "Google Cloud（GCP）",
        },
        common: {
          default: "默认",
        },
        apiKey: {
          title: "Google Cloud API 密钥",
          promptTitle: "Google Cloud API 密钥",
          promptBody:
            "创建启用 Text-to-Speech API 的 API 密钥。可选：将密钥限制到此应用（iOS bundle id / Android package+SHA1）。",
        },
        androidCertSha1: {
          title: "Android 证书 SHA-1（可选）",
          subtitle: "仅在你将 API 密钥限制到 Android 应用时需要。",
          promptTitle: "Android 证书 SHA-1",
          promptBody: "示例：AA:BB:CC:...（来自签名证书）。",
        },
        language: {
          title: "语言",
          subtitle: "语音列表的可选筛选。",
          searchPlaceholder: "搜索语言",
          allTitle: "全部",
          allSubtitle: "显示所有语言的声音。",
        },
        speakingRate: {
          title: "语速",
          subtitle: "0.25–4.0（留空使用语音默认值）。",
          promptTitle: "语速",
          promptBody: "设置语速（0.25–4.0）。留空使用默认值。",
        },
        pitch: {
          title: "音高",
          subtitle: "-20–20（留空使用语音默认值）。",
          promptTitle: "音高",
          promptBody: "设置音高（-20–20）。留空使用默认值。",
        },
        voice: {
          title: "声音",
          subtitle: "选择一个 Google Cloud 声音。",
          searchPlaceholder: "搜索声音",
          selectPrompt: "选择…",
          setApiKeyPrompt: "设置 API 密钥",
          loadingTitle: "正在加载声音…",
        },
        format: {
          title: "格式",
          subtitle: "MP3 更小；WAV 为未压缩。",
          mp3Subtitle: "体积更小，兼容性更广。",
          wavSubtitle: "体积更大，未压缩。",
        },
        alerts: {
          missingApiKey: "缺少 Google Cloud API 密钥。",
          missingVoice: "请先选择一个 Google Cloud 声音。",
        },
      },
      googleGeminiStt: {
        provider: {
          title: "Google Gemini（音频）",
          subtitle: "使用 Gemini 多模态模型转录音频。",
          detail: "谷歌 Gemini",
        },
        apiKey: {
          title: "Gemini API 密钥",
          promptTitle: "Gemini API 密钥",
          promptBody: "在 Google AI Studio（Gemini API）中创建 API 密钥。",
        },
        model: {
          title: "Gemini 模型",
          subtitle: "选择用于转录的 Gemini 模型。",
          searchPlaceholder: "搜索模型",
          customTitle: "自定义模型 ID…",
          customSubtitle: "手动输入模型名称。",
          loadingModelsTitle: "正在加载模型…",
          promptTitle: "Gemini 模型",
          promptBody: "示例：gemini-2.5-flash",
        },
        language: {
          title: "语言",
          subtitle: "可选提示，用于提高转录准确性。",
          searchPlaceholder: "搜索语言",
          autoTitle: "自动",
          autoSubtitle: "不提供语言提示。",
        },
      },
      kokoro: {
        common: {
          default: "默认",
          none: "无",
        },
        runtime: {
          title: "Kokoro 运行时",
          unsupportedSubtitle: "此设备/运行时不支持 Kokoro。",
          unavailableDetail: "不可用",
        },
        manifest: {
          title: "模型包清单",
          subtitle:
            "默认使用 Happier 模型包（可通过 EXPO_PUBLIC_HAPPIER_MODEL_PACK_MANIFESTS 覆盖）。",
          detailResolved: "已解析",
          detailMissing: "缺失",
        },
        assetPack: {
          title: "Kokoro 模型包",
          subtitleNative: "选择 Kokoro 使用的资源包。",
          subtitleWeb: "选择 Kokoro 使用的运行时配置。",
        },
        model: {
          title: "Kokoro 模型",
          subtitleNative: "下载所需文件以启用设备端合成。",
          subtitleWeb: "按需下载。使用 WebAssembly（测试版）。",
        },
        modelStatus: {
          downloading: "下载中…",
          downloadingPrefix: "下载中",
          ready: "就绪",
          error: "错误",
          notDownloaded: "未下载",
        },
        removeAssets: {
          title: "移除 Kokoro 资源",
          subtitle: "通过移除已下载的 Kokoro 文件释放存储空间。",
          detailRemove: "移除",
          confirmTitle: "移除 Kokoro 资源？",
          confirmBody: "这会从本设备移除已下载的 Kokoro 文件。",
          confirmButton: "移除",
        },
        updates: {
          title: "检查模型更新",
          subtitle: "手动检查是否有更新的模型包可用。",
          check: "检查",
          upToDate: "已是最新",
          updateAvailable: "有可用更新",
        },
        alerts: {
          runtimeUnsupported: {
            body: "此设备/运行时不支持 Kokoro。",
          },
          missingManifest: {
            title: "清单 URL 缺失",
            body: "无法解析模型包清单 URL。请检查 EXPO_PUBLIC_HAPPIER_MODEL_PACK_MANIFESTS（或旧版 Kokoro 环境变量）。",
          },
          notInstalledTitle: "未安装",
          notInstalledBody: "请先下载模型包以启用更新检查。",
          upToDateTitle: "已是最新",
          upToDateBody: "此模型包没有可用更新。",
          updateAvailableTitle: "有可用更新",
          updateAvailableBody: ({ remoteBuild }: { remoteBuild: string | null }) =>
            `现在下载此模型包的最新版本吗？${remoteBuild ? `\n\n远程构建：${remoteBuild}` : ""}`,
          updatedTitle: "已更新",
          updatedBody: "模型包已成功更新。",
          updateFailedTitle: "更新失败",
          updateFailedBody: ({ message }: { message: string }) =>
            `无法更新此模型包。\n\n${message}`,
        },
        voice: {
          title: "语音",
          subtitleNative: "选择 Kokoro 语音。",
          searchPlaceholder: "搜索语音",
          titleWeb: "Kokoro 语音",
          subtitleWeb: "选择用于回复的设备端语音。",
          loadingVoicesTitle: "正在加载语音…",
        },
        speed: {
          title: "速度",
          subtitle: "调整语速（0.5–2.0）。",
        },
        web: {
          warmingUp: "预热中…",
          clearCache: {
            confirmTitle: "清除 Kokoro 缓存？",
            confirmBody:
              "这会从本设备移除已下载的 Kokoro 模型和语音文件。",
            confirmButton: "清除",
          },
          cacheDetail: {
            modelFiles: "模型文件",
            voices: "语音",
          },
          cache: {
            title: "Kokoro 缓存",
            subtitle: "管理本设备上已下载的 Kokoro 文件。",
          },
        },
      },
      localNeuralStt: {
        modelPack: {
          title: "模型包",
          subtitle: "流式 STT 模型包 ID。",
        },
        modelFiles: {
          title: "模型文件",
          subtitle: "下载所需文件以启用设备端流式 STT。",
        },
        removeModelFiles: {
          title: "移除模型文件",
          subtitle: "通过移除已下载的模型文件释放存储空间。",
          confirmTitle: "移除模型文件？",
          confirmBody: "这将从此设备移除已下载的 STT 模型包。",
        },
        status: {
          installed: "已安装",
          installedWithBuild: ({ build }: { build: string }) =>
            `已安装 • ${build}`,
          notInstalled: "未安装",
        },
        language: {
          title: "语言",
          subtitle: "可选的 BCP-47 语言标签。",
          promptTitle: "语言",
          promptBody: "输入 BCP-47 语言标签（例如：en, en-US）。",
        },
        alerts: {
          downloadFailedTitle: "下载失败",
          downloadFailedBody: ({ message }: { message: string }) =>
            `无法下载此模型包。\n\n${message}`,
          notInstalledTitle: "未安装",
          notInstalledBody: "请先下载模型包以启用更新检查。",
          upToDateBody: "此模型包没有可用更新。",
          updateAvailableBody: ({ remoteBuild }: { remoteBuild: string | null }) =>
            `现在下载此模型包的最新版本吗？${remoteBuild ? `\n\n远程构建：${remoteBuild}` : ""}`,
          updatedTitle: "已更新",
          updatedBody: "模型包已成功更新。",
          updateFailedTitle: "更新失败",
          updateFailedBody: ({ message }: { message: string }) =>
            `无法更新此模型包。\n\n${message}`,
        },
      },
      conversationMode: "对话模式",
      conversationModeSubtitle: "直接写入会话，或使用中介并显式提交",
      conversation: {
        mode: {
          voiceAgentSubtitle: "使用语音代理（显式提交、工具控制）。",
          directTitle: "直连会话",
          directSubtitle: "直接将语音写入当前会话。",
        },
        handsFree: {
          title: "免提",
          enableTitle: "启用免提",
          silenceTitle: "静默超时（毫秒）",
          minSpeechTitle: "最短语音（毫秒）",
        },
        customBackendIdSubtitle: "输入自定义后端 ID。",
        searchBackendsPlaceholder: "搜索后端",
        searchModelsPlaceholder: "搜索模型",
        machineAutoSubtitle: "根据最近使用情况自动选择机器。",
        rootSessionPolicy: {
          title: "根会话策略",
          fallbackSubtitle: "请选择策略。",
          singleTitle: "单次",
          singleSubtitle: "每次都创建新的根会话。",
          keepWarmTitle: "保持热启动",
          keepWarmSubtitle: "尽可能复用已有的热启动根会话。",
          maxWarmRootsTitle: "最大热根数",
          maxWarmRootsSubtitle: "限制可保留的热启动根会话数量。",
        },
        persistence: {
          title: "转写持久化",
          ephemeralTitle: "临时",
          ephemeralSubtitle: "不在会话之间保存语音代理状态。",
          persistentTitle: "持久",
          persistentSubtitle: "在会话之间保存语音代理状态（可续接）。",
        },
        resetVoiceAgent: {
          title: "重置语音代理状态",
          subtitle: "清除语音代理的持久状态。",
          confirmBody: "这将清除已保存的语音代理状态，无法撤销。",
        },
        agentSettings: {
          title: "语音代理",
        },
        backend: {
          daemonSubtitle: "使用 Happier 后端并支持提供方续接。",
          openAiSubtitle: "连接到 OpenAI 兼容的 HTTP 端点。",
        },
        agentMachine: {
          title: "代理机器",
          fallbackSubtitle: "选择语音代理运行的位置。",
          stayInVoiceHomeTitle: "停留在 voice home",
          stayInVoiceHomeEnabledSubtitle:
            "让代理保持在 voice home 机器上运行。",
          stayInVoiceHomeDisabledSubtitle: "允许代理跟随会话机器。",
          allowTeleportTitle: "允许传送",
          teleportEnabledSubtitle: "需要时允许将代理迁移到其他机器。",
          teleportDisabledSubtitle: "已禁用传送。",
        },
        agentSource: {
          followSessionTitle: "跟随会话",
          followSessionSubtitle: "使用会话后端与配置。",
          fixedAgentTitle: "固定代理",
          fixedAgentSubtitle: "始终使用特定代理后端。",
        },
        permissionPolicy: {
          readOnlySubtitle: "可查看上下文，但不能运行工具。",
          noToolsSubtitle: "应避免工具请求，并且绝不运行工具。",
        },
        chatModelSource: {
          sessionSubtitle: "聊天使用会话模型配置。",
          customSubtitle: "覆盖语音代理聊天模型 ID。",
        },
        chatModelId: {
          title: "语音代理聊天模型 ID",
          subtitle: "当聊天模型来源设为“自定义模型”时使用。",
        },
        commitModelSource: {
          chatSubtitle: "提交使用代理聊天模型。",
          sessionSubtitle: "提交使用会话模型配置。",
          customSubtitle: "覆盖语音代理提交模型 ID。",
        },
        commitModelId: {
          title: "语音代理提交模型 ID",
          subtitle: "当提交模型来源设为“自定义模型”时使用。",
        },
        commitIsolation: {
          title: "提交隔离",
          subtitle: "为提交生成使用单独的提供方会话（高级）。",
        },
        resumability: {
          modeTitle: "续接",
          replayTitle: "回放",
          replaySubtitle: "通过回放最近消息来续接。",
          providerResumeTitle: "提供方续接",
          providerResumeSubtitle: "使用提供方会话状态续接（如支持）。",
          disabledVoiceAgent: "需要 Happier Voice Agent。",
          disabledDaemonBackend: "需要 Daemon 后端。",
          disabledAgentNoProviderResume: "所选代理不支持提供方续接。",
        },
        providerResumeFallback: {
          title: "回退到回放",
          subtitle: "如果提供方续接失败，则回退到回放。",
        },
        replayRecentMessagesPromptBody: "包含多少条最近消息（1–100）。",
        prewarm: {
          title: "连接时预热",
          subtitle: "连接后立即启动语音代理。",
        },
        welcome: {
          title: "欢迎消息",
          offTitle: "关闭",
          offSubtitle: "不发送欢迎消息。",
          immediateTitle: "立即",
          immediateSubtitle: "代理启动后立即发送欢迎消息。",
          onFirstTurnTitle: "首次发言",
          onFirstTurnSubtitle: "你第一次说话时发送欢迎消息。",
        },
        verbosity: {
          shortSubtitle: "让代理回复更简短。",
          balancedSubtitle: "需要时允许稍多细节。",
        },
        streaming: {
          title: "流式传输",
          enableTitle: "启用流式传输",
          enableTtsTitle: "启用 TTS 流式传输",
          ttsChunkCharsTitle: "TTS 分块字符数",
          ttsChunkCharsPromptBody:
            "在请求下一段 TTS 前缓冲多少字符（32–2000）。",
        },
        network: {
          title: "网络",
          timeoutTitle: "网络超时（毫秒）",
          timeoutPromptBody: "请求端点的超时时间（1000–60000）。",
        },
      },
      mediatorBackend: "中介后端",
      mediatorBackendSubtitle: "Daemon（使用 Happier 后端）或 OpenAI 兼容 HTTP",
      mediatorBackendDaemon: "守护进程",
      mediatorBackendOpenAi: "OpenAI 兼容 HTTP",
      mediatorAgentSource: "中介代理来源",
      mediatorAgentSourceSubtitle: "使用会话后端，或强制选择特定代理后端",
      mediatorAgentSourceSession: "会话后端",
      mediatorAgentSourceAgent: "特定代理",
      mediatorAgentId: "中介代理",
      mediatorAgentIdSubtitle: "中介使用的代理后端（不使用会话时）",
      mediatorPermissionPolicy: "中介权限",
      mediatorPermissionPolicySubtitle: "在中介对话中限制工具使用",
      mediatorPermissionReadOnly: "只读",
      mediatorPermissionNoTools: "不使用工具",
      mediatorVerbosity: "中介详细程度",
      mediatorVerbositySubtitle: "中介回复的详细程度",
      mediatorVerbosityShort: "简短",
      mediatorVerbosityBalanced: "均衡",
      mediatorIdleTtl: "中介空闲 TTL",
      mediatorIdleTtlSubtitle: "空闲后自动停止（60–3600 秒）",
      mediatorIdleTtlTitle: "中介空闲 TTL（秒）",
      mediatorIdleTtlDescription: "请输入 60 到 3600 之间的数字。",
      mediatorIdleTtlInvalid: "请输入 60 到 3600 之间的数字。",
      mediatorChatModelSource: "中介模型来源（聊天）",
      mediatorChatModelSourceSubtitle: "使用会话模型，或自定义快速模型",
      mediatorChatModelSourceSession: "会话模型",
      mediatorChatModelSourceCustom: "自定义模型",
      mediatorCommitModelSource: "中介模型来源（提交）",
      mediatorCommitModelSourceSubtitle: "使用聊天模型、会话模型或自定义模型",
      mediatorCommitModelSourceChat: "聊天模型",
      mediatorCommitModelSourceSession: "会话模型",
      mediatorCommitModelSourceCustom: "自定义模型",
      chatBaseUrl: "聊天基础 URL",
      chatBaseUrlTitle: "聊天基础 URL",
      chatBaseUrlDescription:
        "OpenAI 兼容 chat completion 端点的 Base URL（通常以 /v1 结尾）。",
      chatApiKey: "Chat API 密钥",
      chatApiKeyTitle: "Chat API 密钥",
      chatApiKeyDescription:
        "Chat 服务器可选 API 密钥（加密存储）。留空以清除。",
      chatModel: "Chat 模型",
      chatModelSubtitle: "用于实时语音对话的快速模型",
      chatModelTitle: "Chat 模型",
      chatModelDescription: "发送给 chat 服务器的模型名称（OpenAI 兼容字段）。",
      modelCustomTitle: "自定义…",
      modelCustomSubtitle: "输入模型 ID",
      commitModel: "Commit 模型",
      commitModelSubtitle: "用于生成最终指令消息的模型",
      commitModelTitle: "Commit 模型",
      commitModelDescription: "生成最终 commit 消息时使用的模型名称。",
      chatTemperature: "聊天温度",
      chatTemperatureSubtitle: "控制随机性（0–2）",
      chatTemperatureTitle: "聊天温度",
      chatTemperatureDescription: "请输入 0 到 2 之间的数字。",
      chatTemperatureInvalid: "请输入 0 到 2 之间的数字。",
      chatMaxTokens: "聊天最大 token 数",
      chatMaxTokensSubtitle: "限制回复长度（留空 = 默认）",
      chatMaxTokensTitle: "聊天最大 token 数",
      chatMaxTokensDescription: "请输入正整数，或留空使用默认值。",
      chatMaxTokensPlaceholder: "留空使用默认",
      chatMaxTokensUnlimited: "默认",
      chatMaxTokensInvalid: "请输入正数或留空。",
      sttBaseUrl: "STT 基础 URL",
      sttBaseUrlTitle: "STT 基础 URL",
      sttBaseUrlDescription:
        "OpenAI 兼容转写端点的 Base URL（通常以 /v1 结尾）。",
      sttApiKey: "STT API 密钥",
      sttApiKeyTitle: "STT API 密钥",
      sttApiKeyDescription: "STT 服务器可选 API 密钥（加密存储）。留空以清除。",
      sttModel: "STT 模型",
      sttModelSubtitle: "转写请求中发送的模型名称",
      sttModelTitle: "STT 模型",
      sttModelDescription: "发送给 STT 服务器的模型名称（OpenAI 兼容字段）。",
      deviceStt: "设备 STT（实验）",
      deviceSttSubtitle:
        "使用设备端语音识别，而不是 OpenAI 兼容端点",
      sttProvider: "STT 提供方",
      neuralStt: {
        title: "设备端 STT",
        webNotAvailableSubtitle:
          "Web 不可用。请使用设备、OpenAI 兼容或 Gemini STT。",
      },
      ttsBaseUrl: "TTS 基础 URL",
      ttsBaseUrlTitle: "TTS 基础 URL",
      ttsBaseUrlDescription:
        "OpenAI 兼容语音端点的 Base URL（通常以 /v1 结尾）。",
      ttsApiKey: "TTS API 密钥",
      ttsApiKeyTitle: "TTS API 密钥",
      ttsApiKeyDescription: "TTS 服务器可选 API 密钥（加密存储）。留空以清除。",
      ttsModel: "TTS 模型",
      ttsModelSubtitle: "语音请求中发送的模型名称",
      ttsModelTitle: "TTS 模型",
      ttsModelDescription: "发送给 TTS 服务器的模型名称（OpenAI 兼容字段）。",
      ttsVoice: "TTS 声音",
      ttsVoiceSubtitle: "语音请求中发送的声音名称/ID",
      ttsVoiceTitle: "TTS 声音",
      ttsVoiceDescription:
        "发送给 TTS 服务器的声音名称/ID（OpenAI 兼容字段）。",
      ttsFormat: "TTS 格式",
      ttsFormatSubtitle: "TTS 返回的音频格式",
      ttsFormatOptions: {
        mp3Subtitle: "输出更小，兼容性更强。",
        wavSubtitle: "输出更大，未压缩。",
      },
      testTts: "测试 TTS",
      testTtsSubtitle:
        "使用已配置的本地 TTS（设备 TTS 或端点）播放一段短示例",
      testTtsSample: "你好，这里是 Happier。这是你本地 TTS 的测试。",
      testTtsMissingBaseUrl: "请先设置 TTS 基础 URL。",
      testTtsFailed:
        "TTS test failed. Check your base URL, API key, model, and voice.",
      deviceTts: "设备 TTS（实验）",
      deviceTtsSubtitle:
        "使用设备端语音合成，而不是 OpenAI 兼容端点",
      ttsProvider: "TTS 提供方",
      ttsProviderSubtitle:
        "选择设备 TTS、OpenAI 兼容端点或 Kokoro（Web/桌面）",

      autoSpeak: "自动朗读回复",
      autoSpeakSubtitle: "发送语音消息后朗读下一条助手回复",
      bargeIn: "打断",
      speaking: "正在说话…",
    },
    privacy: {
      title: "隐私",
      footer: "语音服务商会接收所选的会话上下文。",
      shareSessionSummary: "分享会话摘要",
      shareSessionSummarySubtitle: "在语音上下文中包含会话摘要",
      shareRecentMessages: "分享最近消息",
      shareRecentMessagesSubtitle: "在语音上下文中包含最近消息",
      recentMessagesCount: "最近消息数量",
      recentMessagesCountSubtitle: "包含多少条最近消息（0–50）",
      recentMessagesCountTitle: "最近消息数量",
      recentMessagesCountDescription: "请输入 0 到 50 之间的数字。",
      recentMessagesCountInvalid: "请输入 0 到 50 之间的数字。",
      shareToolNames: "分享工具名称",
      shareToolNamesSubtitle: "在语音上下文中包含工具名称/描述",
      shareDeviceInventory: "共享设备清单",
      shareDeviceInventorySubtitle:
        "允许语音列出最近的工作区、机器和服务器",
      shareToolArgs: "分享工具参数",
      shareToolArgsSubtitle: "包含工具参数（可能包含路径或秘密）",
      sharePermissionRequests: "分享权限请求",
      sharePermissionRequestsSubtitle: "向语音转发权限提示",
      shareFilePaths: "分享本地文件路径",
      shareFilePathsSubtitle: "在语音上下文中包含本地路径（不推荐）",
    },
    languageTitle: "语言",
    languageDescription:
      "选择您希望语音助手交互使用的语言。此设置将在您的所有设备间同步。",
    preferredLanguage: "首选语言",
    preferredLanguageSubtitle: "语音助手响应使用的语言",
    language: {
      searchPlaceholder: "搜索语言...",
      title: "语言",
      footer: ({ count }: { count: number }) => `${count} 种可用语言`,
      autoDetect: "自动检测",
      autoDetectSubtitle: "让识别器自行决定（推荐）。",
      customTitle: "自定义…",
      customSubtitle: "输入一个 BCP-47 语言标签。",
      options: {
        english: "英语",
        englishUs: "英语（美国）",
        french: "法语",
        spanish: "西班牙语",
      },
    },
  },

  settingsAccount: {
    // Account settings screen
    accountInformation: "账户信息",
    status: "状态",
    statusActive: "活跃",
    statusNotAuthenticated: "未认证",
    anonymousId: "匿名 ID",
    publicId: "公共 ID",
    notAvailable: "不可用",
    linkNewDevice: "扫描二维码以链接新设备",
    linkNewDeviceSubtitle: "扫描新设备上显示的二维码",
    profile: "个人资料",
    name: "姓名",
    github: "GitHub",
    showGitHubOnProfile: "在个人资料中显示",
    showProviderOnProfile: ({ provider }: { provider: string }) =>
      `在个人资料中显示 ${provider}`,
    tapToDisconnect: "点击断开连接",
    server: "服务器",
    backup: "备份",
    backupDescription:
      "您的密钥是恢复账户的唯一方法。请将其保存在安全的地方，比如密码管理器中。",
    secretKey: "密钥",
    tapToReveal: "点击显示",
    tapToHide: "点击隐藏",
    secretKeyLabel: "密钥（点击复制）",
    secretKeyCopied: "密钥已复制到剪贴板。请将其保存在安全的地方！",
    secretKeyCopyFailed: "复制密钥失败",
    privacy: "隐私",
    privacyDescription:
      "通过分享匿名使用数据来帮助改进应用。不会收集个人信息。",
    analytics: "分析",
    analyticsDisabled: "不分享数据",
    analyticsEnabled: "分享匿名使用数据",
    crashReports: "崩溃报告",
    crashReportsDisabled: "不分享崩溃报告",
    crashReportsEnabled: "分享崩溃报告",
    dangerZone: "危险区域",
    logout: "登出",
    logoutSubtitle: "登出并清除本地数据",
    logoutConfirm: "您确定要登出吗？请确保您已备份密钥！",
    encryptionUpdateFailed: "更新加密设置失败",
    secretKeyMissing: "密钥不可用。请先恢复你的账户。",
    restoreRequiredTitle: "需要恢复",
    restoreRequiredBody:
      "该账户包含已加密的历史记录。要在此设备上重新启用加密，请先恢复你的密钥。如果你丢失了密钥，可以重置账户以重新开始（旧的加密历史无法恢复）。",
  },

  settingsLanguage: {
    // Language settings screen
    title: "语言",
    description: "选择您希望应用界面使用的语言。此设置将在您的所有设备间同步。",
    currentLanguage: "当前语言",
    automatic: "自动",
    automaticSubtitle: "从设备设置中检测",
    needsRestart: "语言已更改",
    needsRestartMessage: "应用需要重启以应用新的语言设置。",
    restartNow: "立即重启",
  },

  connectButton: {
    authenticate: "认证终端",
    authenticateWithUrlPaste: "通过 URL 粘贴认证终端",
    pasteAuthUrl: "粘贴来自您终端的认证 URL",
  },

  updateBanner: {
    updateAvailable: "有可用更新",
    pressToApply: "点击应用更新",
    whatsNew: "更新内容",
    seeLatest: "查看最新更新和改进",
    nativeUpdateAvailable: "应用更新可用",
    tapToUpdateAppStore: "点击在 App Store 中更新",
    tapToUpdatePlayStore: "点击在 Play Store 中更新",
  },

  changelog: {
    // Used by the changelog screen
    version: ({ version }: { version: number }) => `版本 ${version}`,
    noEntriesAvailable: "没有可用的更新日志条目。",
  },

  terminal: {
    // Used by terminal connection screens
    webBrowserRequired: "需要 Web 浏览器",
    webBrowserRequiredDescription:
      "出于安全原因，终端连接链接只能在 Web 浏览器中打开。请使用二维码扫描器或在计算机上打开此链接。",
    processingConnection: "正在处理连接...",
    invalidConnectionLink: "无效的连接链接",
    invalidConnectionLinkDescription: "连接链接缺失或无效。请检查 URL 并重试。",
    connectTerminal: "连接终端",
    terminalRequestDescription:
      "有终端正在请求连接到您的 Happier Coder 账户。这将允许终端安全地发送和接收消息。",
    connectionDetails: "连接详情",
    publicKey: "公钥",
    encryption: "加密",
    endToEndEncrypted: "端到端加密",
    acceptConnection: "接受连接",
    connecting: "连接中...",
    reject: "拒绝",
    security: "安全",
    securityFooter:
      "此连接链接在您的浏览器中安全处理，从未发送到任何服务器。您的私人数据将保持安全，只有您能解密消息。",
    securityFooterDevice:
      "此连接在您的设备上安全处理，从未发送到任何服务器。您的私人数据将保持安全，只有您能解密消息。",
    clientSideProcessing: "客户端处理",
    linkProcessedLocally: "链接在浏览器中本地处理",
    linkProcessedOnDevice: "链接在设备上本地处理",
    switchServerToConnectTerminal: ({ serverUrl }: { serverUrl: string }) =>
      `此连接对应 ${serverUrl}。是否切换服务器并继续？`,
  },

  modals: {
    // Used across connect flows and settings
    authenticateTerminal: "认证终端",
    pasteUrlFromTerminal: "粘贴来自您终端的认证 URL",
    deviceLinkedSuccessfully: "设备链接成功",
    terminalConnectedSuccessfully: "终端连接成功",
    terminalAlreadyConnected: "连接已使用",
    terminalConnectionAlreadyUsedDescription: "此连接链接已被另一台设备使用。要将多个设备连接到同一终端，请在所有设备上退出登录并登录同一账户。",
    authRequestExpired: "连接已过期",
    authRequestExpiredDescription: "此连接链接已过期。请从您的终端生成新链接。",
    pleaseSignInFirst: "请先登录（或创建账户）。",
    invalidAuthUrl: "无效的认证 URL",
    microphoneAccessRequiredTitle: "需要麦克风权限",
    microphoneAccessRequiredRequestPermission:
      "Happier 需要访问你的麦克风用于语音聊天。出现提示时请授予权限。",
    microphoneAccessRequiredEnableInSettings:
      "Happier 需要访问你的麦克风用于语音聊天。请在设备设置中启用麦克风权限。",
    microphoneAccessRequiredBrowserInstructions:
      "请在浏览器设置中允许麦克风访问。你可能需要点击地址栏中的锁形图标，并为此网站启用麦克风权限。",
    openSettings: "打开设置",
    developerMode: "开发者模式",
    developerModeEnabled: "开发者模式已启用",
    developerModeDisabled: "开发者模式已禁用",
    disconnectGithub: "断开 GitHub 连接",
    disconnectGithubConfirm:
      "断开后将停用好友功能和基于好友的共享，直到你重新连接。",
    disconnectService: ({ service }: { service: string }) =>
      `断开 ${service} 连接`,
    disconnectServiceConfirm: ({ service }: { service: string }) =>
      `您确定要断开 ${service} 与您账户的连接吗？`,
    disconnect: "断开连接",
    failedToConnectTerminal: "连接终端失败",
    cameraPermissionsRequiredToConnectTerminal: "连接终端需要相机权限",
    failedToLinkDevice: "链接设备失败",
    cameraPermissionsRequiredToScanQr: "扫描二维码需要相机权限",
    qrScannerUnavailable: "无法打开二维码扫描器。请重试或手动输入 URL。",
  },

  navigation: {
    // Navigation titles and screen headers
    connectTerminal: "连接终端",
    linkNewDevice: "链接新设备",
    restoreWithSecretKey: "通过密钥恢复",
    whatsNew: "更新日志",
    friends: "好友",
    automations: "自动化",
    automation: "自动化",
    newAutomation: "新建自动化",
    sourceControl: "版本控制",
    developerTools: "开发者工具",
    listComponentsDemo: "列表组件演示",
    typography: "字体排版",
    colors: "颜色",
    toolViewsDemo: "工具视图演示",
    maskedProgress: "遮罩进度",
    shimmerViewDemo: "微光效果演示",
    multiTextInput: "多行文本输入",
    connectClaude: "连接 Claude",
    zenNewTask: "新建任务",
    zenTaskDetails: "任务详情",
  },

  welcome: {
    // Main welcome screen for unauthenticated users
    title: "Codex 和 Claude Code 移动客户端",
    subtitle: "端到端加密，您的账户仅存储在您的设备上。",
    createAccount: "创建账户",
    chooseEncryptionTitle: "选择加密方式",
    chooseEncryptionBody: "此服务器支持加密与不加密账户。请选择你希望如何存储账户数据。",
    chooseEncryptionEncrypted: "继续使用端到端加密",
    chooseEncryptionPlain: "继续不加密",
    signUpWithProvider: ({ provider }: { provider: string }) =>
      `使用 ${provider} 继续`,
    signInWithCertificate: "使用证书登录",
    linkOrRestoreAccount: "链接或恢复账户",
    loginWithMobileApp: "使用移动应用登录",
    serverUnavailableTitle: "无法连接到服务器",
    serverUnavailableBody: ({ serverUrl }: { serverUrl: string }) =>
      `无法连接到 ${serverUrl}。请重试或更改服务器以继续。`,
    serverIncompatibleTitle: "服务器不受支持",
    serverIncompatibleBody: ({ serverUrl }: { serverUrl: string }) =>
      `${serverUrl} 返回了意外的响应。请更新服务器或更改服务器以继续。`,
  },

  review: {
    // Used by utils/requestReview.ts
    enjoyingApp: "喜欢这个应用吗？",
    feedbackPrompt: "我们很希望听到您的反馈！",
    yesILoveIt: "是的，我喜欢！",
    notReally: "不太喜欢",
  },

  items: {
    // Used by Item component for copy toast
    copiedToClipboard: ({ label }: { label: string }) =>
      `${label} 已复制到剪贴板`,
  },

    machine: {
    launchNewSessionInDirectory: "在目录中启动新会话",
    offlineUnableToSpawn: "设备离线时无法启动",
    offlineHelp:
      "• 确保您的计算机在线\n• 运行 `happier daemon status` 进行诊断\n• 您是否在运行最新的 CLI 版本？请使用 `npm install -g @happier-dev/cli@latest` 升级",
    daemon: "守护进程",
    status: "状态",
    customPathPlaceholder: "输入自定义路径",
    tools: {
      title: "工具",
      installablesTitle: "可安装项",
      installablesSubtitle: "管理此设备的可安装工具。",
    },
    installables: {
      screenTitle: "可安装项",
      aboutGroupTitle: "关于",
      aboutSubtitle: "管理 Happier 可在此设备上安装并保持最新的工具。",
      experimentalGroupTitle: ({ title }: { title: string }) => `${title}（实验性）`,
      autoInstallTitle: "按需自动安装",
      autoInstallSubtitle: "当所选后端需要时在后台安装（尽力而为）。",
      autoUpdateTitle: "自动更新",
      autoUpdatePromptTitle: "自动更新",
      autoUpdatePromptBody: "选择 Happier 应如何处理此可安装项的更新。",
      autoUpdateModes: {
        off: "关闭",
        notify: "通知",
        auto: "自动",
      },
    },
    daemonStatus: {
      unknown: "未知",
      stopped: "已停止",
      likelyAlive: "可能正在运行",
    },
    stopDaemon: "停止守护进程",
    stopDaemonConfirmTitle: "停止守护进程？",
    stopDaemonConfirmBody:
      "在您重新启动电脑上的守护进程之前，您将无法在此设备上创建新会话。当前会话将保持运行。",
    daemonStoppedTitle: "守护进程已停止",
    stopDaemonFailed: "停止守护进程失败。它可能未在运行。",
    renameTitle: "重命名设备",
    renameDescription: "为此设备设置自定义名称。留空则使用默认主机名。",
      renamePlaceholder: "输入设备名称",
      renamedSuccess: "设备重命名成功",
      renameFailed: "设备重命名失败",
      actions: {
        removeMachine: "移除设备",
        removeMachineSubtitle:
          "撤销此设备并将其从你的账号中移除。",
        removeMachineConfirmBody:
          "这将撤销此设备的访问权限（包括访问密钥与自动化分配）。你以后可以通过在 CLI 再次登录来重新连接。",
        removeMachineAlreadyRemoved:
          "此设备已从你的账号中移除。",
      },
      lastKnownPid: "最后已知 PID",
      lastKnownHttpPort: "最后已知 HTTP 端口",
      startedAt: "启动时间",
      cliVersion: "CLI 版本",
    daemonStateVersion: "守护进程状态版本",
    activeSessions: ({ count }: { count: number }) => `活跃会话 (${count})`,
    machineGroup: "设备",
    host: "主机",
    machineId: "设备 ID",
    username: "用户名",
    homeDirectory: "主目录",
    platform: "平台",
    architecture: "架构",
    lastSeen: "最后活跃",
    never: "从未",
    metadataVersion: "元数据版本",
    detectedClis: "已检测到的 CLI",
    detectedCliNotDetected: "未检测到",
    detectedCliUnknown: "未知",
    detectedCliNotSupported: "不支持（请更新 @happier-dev/cli）",
    untitledSession: "无标题会话",
    back: "返回",
    notFound: "未找到设备",
    unknownMachine: "未知设备",
    unknownPath: "未知路径",
    previousSessionsTitle: "之前的会话（最多最近 5 个）",
    tmux: {
      overrideTitle: "覆盖全局 tmux 设置",
      overrideEnabledSubtitle: "自定义 tmux 设置将应用于此设备上的新会话。",
      overrideDisabledSubtitle: "新会话使用全局 tmux 设置。",
      notDetectedSubtitle: "此设备未检测到 tmux。",
      notDetectedMessage: "此设备未检测到 tmux。请安装 tmux 并刷新检测。",
    },
    windows: {
      title: "Windows",
      remoteSessionConsoleTitle: "为远程会话显示控制台",
      remoteSessionConsoleVisibleSubtitle:
        "远程会话会在此设备上以可见的控制台窗口打开。",
      remoteSessionConsoleHiddenSubtitle:
        "远程会话会以隐藏方式启动，以避免窗口反复打开/闪烁。",
      remoteSessionConsoleUpdateFailed: "无法更新 Windows 会话控制台设置。",
    },
  },

  message: {
    switchedToMode: ({ mode }: { mode: string }) => `已切换到 ${mode} 模式`,
    discarded: "已丢弃",
    unknownEvent: "未知事件",
    usageLimitUntil: ({ time }: { time: string }) => `使用限制到 ${time}`,
    unknownTime: "未知时间",
  },

  chatFooter: {
    permissionsTerminalOnly:
      "权限仅在终端中显示。重置或发送消息即可从应用中控制。",
    sessionRunningLocally:
      "此会话正在本机上以本地模式运行。你可以切换到远程以在应用中控制。",
    switchToRemote: "切换到远程",
    localModeAvailable: "此会话可使用本地模式。",
    localModeUnavailableMachineOffline: "此机器离线时无法使用本地模式。",
    localModeUnavailableDaemonStarted: "由守护进程启动的会话无法使用本地模式。",
    localModeUnavailableNeedsResume: "本地模式需要此提供方支持会话恢复。",
    switchToLocal: "切换到本地",
  },

    codex: {
      // Codex permission dialog buttons
      permissions: {
        yesAlwaysAllowCommand: "是，全局永久允许",
        yesForSession: "是，并且本次会话不再询问",
        stop: "停止",
        stopAndExplain: "停止，并说明该做什么",
      },
    },

    claude: {
      // Claude permission dialog buttons
      permissions: {
        yesAllowAllEdits: "是，允许本次会话的所有编辑",
        yesForTool: "是，不再询问此工具",
        yesForCommandPrefix: "是，不再询问此命令前缀",
        yesForSubcommand: "是，不再询问此子命令",
        yesForCommandName: "是，不再询问此命令",
        stop: "停止",
        noTellClaude: "否，提供反馈",
      },
    },

  textSelection: {
    // Text selection screen
    selectText: "选择文本范围",
    title: "选择文本",
    noTextProvided: "未提供文本",
    textNotFound: "文本未找到或已过期",
    textCopied: "文本已复制到剪贴板",
    failedToCopy: "复制文本到剪贴板失败",
    noTextToCopy: "没有可复制的文本",
    failedToOpen: "无法打开文本选择。请重试。",
  },

  markdown: {
    // Markdown copy functionality
    codeCopied: "代码已复制",
    copyFailed: "复制失败",
    mermaidRenderFailed: "渲染 mermaid 图表失败",
    diffLabel: "差异",
    codeLabel: "代码",
  },

  artifacts: {
    title: "工件",
    countSingular: "1 个工件",
    countPlural: ({ count }: { count: number }) => `${count} 个工件`,
    empty: "暂无工件",
    emptyDescription: "创建您的第一个工件来保存和组织内容",
    new: "新建工件",
    edit: "编辑工件",
    delete: "删除",
    updateError: "更新工件失败。请重试。",
    deleteError: "删除工件失败。请重试。",
    notFound: "未找到工件",
    discardChanges: "放弃更改？",
    discardChangesDescription: "您有未保存的更改。确定要放弃它们吗？",
    deleteConfirm: "删除工件？",
    deleteConfirmDescription: "此工件将被永久删除。",
    noContent: "无内容",
    untitled: "未命名",
    titlePlaceholder: "工件标题",
    bodyPlaceholder: "在此输入内容...",
    save: "保存",
    saving: "保存中...",
    loading: "加载中...",
    error: "加载工件失败",
    titleLabel: "标题",
    bodyLabel: "内容",
    emptyFieldsError: "请输入标题或内容",
    createError: "创建工件失败。请重试。",
  },

  friends: {
    // Friends feature
    title: "好友",
    manageFriends: "管理您的好友和连接",
    sharedSessions: "共享会话",
    noSharedSessions: "暂无共享会话",
    searchTitle: "查找好友",
    pendingRequests: "好友请求",
    myFriends: "我的好友",
    noFriendsYet: "您还没有好友",
    findFriends: "查找好友",
    remove: "删除",
    pendingRequest: "待处理",
    sentOn: ({ date }: { date: string }) => `发送于 ${date}`,
    accept: "接受",
    reject: "拒绝",
    addFriend: "添加好友",
    alreadyFriends: "已是好友",
    requestPending: "请求待处理",
    searchInstructions: "输入用户名搜索好友",
    searchPlaceholder: "输入用户名...",
    searching: "搜索中...",
    userNotFound: "未找到用户",
    noUserFound: "未找到该用户名的用户",
    checkUsername: "请检查用户名后重试",
    howToFind: "如何查找好友",
    findInstructions:
      "通过用户名搜索好友。根据你的服务器设置，你可能需要连接提供方或选择用户名才能使用好友功能。",
    requestSent: "好友请求已发送！",
    requestAccepted: "好友请求已接受！",
    requestRejected: "好友请求已拒绝",
    friendRemoved: "好友已删除",
    confirmRemove: "删除好友",
    confirmRemoveMessage: "确定要删除这位好友吗？",
    cannotAddYourself: "您不能向自己发送好友请求",
    bothMustHaveGithub: "双方都必须连接所需的提供方才能成为好友",
    status: {
      none: "未连接",
      requested: "请求已发送",
      pending: "请求待处理",
      friend: "好友",
      rejected: "已拒绝",
    },
    acceptRequest: "接受请求",
    removeFriend: "移除好友",
    removeFriendConfirm: ({ name }: { name: string }) =>
      `确定要将 ${name} 从好友列表中移除吗？`,
    requestSentDescription: ({ name }: { name: string }) =>
      `您的好友请求已发送给 ${name}`,
    requestFriendship: "请求加为好友",
    cancelRequest: "取消好友请求",
    cancelRequestConfirm: ({ name }: { name: string }) =>
      `取消发送给 ${name} 的好友请求？`,
    denyRequest: "拒绝请求",
    nowFriendsWith: ({ name }: { name: string }) => `您现在与 ${name} 是好友了`,
    disabled: "此服务器已禁用好友功能。",
    username: {
      required: "请选择一个用户名以使用好友功能。",
      taken: "该用户名已被占用。",
      invalid: "该用户名不可用。",
      disabled: "此服务器未启用基于用户名的好友功能。",
      preferredNotAvailable: "你偏好的用户名在此服务器上不可用。请选择另一个。",
      preferredNotAvailableWithLogin: ({ login }: { login: string }) =>
        `你偏好的用户名 @${login} 在此服务器上不可用。请选择另一个。`,
    },
    githubGate: {
      title: "连接 GitHub 才能使用好友",
      body: "好友功能使用 GitHub 用户名进行查找与分享。",
      connect: "连接 GitHub",
      notAvailable: "不可用？",
      notConfigured: "此服务器未配置 GitHub OAuth。",
    },
    providerGate: {
      title: ({ provider }: { provider: string }) =>
        `连接 ${provider} 才能使用好友`,
      body: ({ provider }: { provider: string }) =>
        `好友功能使用 ${provider} 用户名进行查找与分享。`,
      connect: ({ provider }: { provider: string }) => `连接 ${provider}`,
      notAvailable: "不可用？",
      notConfigured: ({ provider }: { provider: string }) =>
        `此服务器未配置 ${provider} OAuth。`,
    },
  },

  usage: {
    // Usage panel strings
    today: "今天",
    last7Days: "过去 7 天",
    last30Days: "过去 30 天",
    totalTokens: "总令牌数",
    totalCost: "总费用",
    tokens: "令牌",
    cost: "费用",
    usageOverTime: "使用趋势",
    byModel: "按模型",
    noData: "暂无使用数据",
  },

  profiles: {
    title: "配置文件",
    subtitle: "管理您的配置文件",
    sessionUses: ({ profile }: { profile: string }) => `此会话使用：${profile}`,
    profilesFixedPerSession:
      "配置文件在每个会话中是固定的。要使用不同的配置文件，请启动新会话。",
    noProfile: "无配置文件",
    noProfileDescription: "创建配置文件以管理您的环境设置",
    addProfile: "添加配置文件",
    addProfileTitle: "添加配置文件标题",
    editProfile: "编辑配置文件",
    profileName: "配置文件名称",
    enterName: "输入配置文件名称",
    baseURL: "基础 URL",
    authToken: "认证令牌",
    enterToken: "输入认证令牌",
    model: "模型",
    defaultModel: "默认模型",
    tmuxSession: "tmux 会话",
    enterTmuxSession: "输入 tmux 会话名称",
    tmuxTempDir: "tmux 临时目录",
    enterTmuxTempDir: "输入 tmux 临时目录",
    tmuxUpdateEnvironment: "更新 tmux 环境",
    deleteConfirm: ({ name }: { name: string }) =>
      `确定要删除配置文件“${name}”吗？`,
    nameRequired: "配置文件名称为必填项",
    builtIn: "内置",
    custom: "自定义",
    builtInSaveAsHint: "保存内置配置文件会创建一个新的自定义配置文件。",
    builtInNames: {
      anthropic: "Anthropic（默认）",
      deepseek: "DeepSeek（推理）",
      zai: "Z.AI (GLM-4.6)",
      codex: "Codex（默认）",
      openai: "OpenAI (GPT-5)",
      azureOpenai: "Azure OpenAI",
      gemini: "Gemini（默认）",
      geminiApiKey: "Gemini（API 密钥）",
      geminiVertex: "Gemini (Vertex AI)",
    },
    groups: {
      favorites: "收藏",
      custom: "你的配置文件",
      builtIn: "内置配置文件",
    },
    actions: {
      viewEnvironmentVariables: "环境变量",
      addToFavorites: "添加到收藏",
      removeFromFavorites: "从收藏中移除",
      editProfile: "编辑配置文件",
      duplicateProfile: "复制配置文件",
      deleteProfile: "删除配置文件",
    },
    copySuffix: "(副本)",
    duplicateName: "已存在同名配置文件",
    setupInstructions: {
      title: "设置说明",
      viewCloudGuide: "查看官方设置指南",
    },
    machineLogin: {
      title: "需要在设备上登录",
      subtitle: "此配置文件依赖所选设备上的 CLI 登录缓存。",
      status: {
        loggedIn: "已登录",
        notLoggedIn: "未登录",
      },
      claudeCode: {
        title: "Claude Code",
        instructions: "运行 `claude`，然后输入 `/login` 登录。",
        warning: "注意：设置 `ANTHROPIC_AUTH_TOKEN` 会覆盖 CLI 登录。",
      },
      codex: {
        title: "Codex",
        instructions: "运行 `codex login` 登录。",
      },
      geminiCli: {
        title: "Gemini CLI",
        instructions: "运行 `gemini auth` 登录。",
      },
    },
    requirements: {
      secretRequired: "机密",
      configured: "已在设备上配置",
      notConfigured: "未配置",
      checking: "检查中…",
      missingConfigForProfile: ({ env }: { env: string }) =>
        `此配置文件要求在本机配置 ${env}。`,
      modalTitle: "需要机密",
      modalBody:
        "此配置需要机密。\n\n支持的选项：\n• 使用设备环境（推荐）\n• 使用应用设置中保存的机密\n• 仅为本次会话输入机密",
      sectionTitle: "要求",
      sectionSubtitle: "这些字段用于预检查就绪状态，避免意外失败。",
      secretEnvVarPromptDescription:
        "输入所需的秘密环境变量名称（例如 OPENAI_API_KEY）。",
      modalHelpWithEnv: ({ env }: { env: string }) =>
        `此配置需要 ${env}。请选择下面的一个选项。`,
      modalHelpGeneric: "此配置需要机密。请选择下面的一个选项。",
      chooseOptionTitle: "选择一个选项",
      machineEnvStatus: {
        theMachine: "设备",
        checkFor: ({ env }: { env: string }) => `检查 ${env}`,
        checking: ({ env }: { env: string }) => `正在检查 ${env}…`,
        found: ({ env, machine }: { env: string; machine: string }) =>
          `在${machine}上找到 ${env}`,
        notFound: ({ env, machine }: { env: string; machine: string }) =>
          `在${machine}上未找到 ${env}`,
      },
      machineEnvSubtitle: {
        checking: "正在检查守护进程环境…",
        found: "已在设备的守护进程环境中找到。",
        notFound: "请在设备的守护进程环境中设置它并重启守护进程。",
      },
      options: {
        none: {
          title: "无",
          subtitle: "不需要机密或 CLI 登录。",
        },
        machineLogin: {
          subtitle: "需要在目标设备上通过 CLI 登录。",
          longSubtitle: "需要在目标设备上登录到所选 AI 后端的 CLI。",
        },
        useMachineEnvironment: {
          title: "使用设备环境",
          subtitleWithEnv: ({ env }: { env: string }) =>
            `从守护进程环境中使用 ${env}。`,
          subtitleGeneric: "从守护进程环境中使用机密。",
        },
        useSavedSecret: {
          title: "使用已保存的机密",
          subtitle: "在应用中选择（或添加）一个已保存的机密。",
        },
        enterOnce: {
          title: "输入机密",
          subtitle: "仅为本次会话粘贴机密（不会保存）。",
        },
      },
      secretEnvVar: {
        title: "机密环境变量",
        subtitle: "输入此提供方期望的机密环境变量名（例如 OPENAI_API_KEY）。",
        label: "环境变量名",
      },
      sections: {
        machineEnvironment: "设备环境",
        useOnceTitle: "仅使用一次",
        useOnceLabel: "输入机密",
        useOnceFooter: "仅为本次会话粘贴机密。不会保存。",
      },
      actions: {
        useMachineEnvironment: {
          subtitle: "使用设备上已存在的密钥开始。",
        },
        useOnceButton: "仅使用一次（仅本次会话）",
      },
    },
    defaultSessionType: "默认会话类型",
    defaultPermissionMode: {
      title: "默认权限模式",
      descriptions: {
        default: "询问权限",
        acceptEdits: "自动批准编辑",
        plan: "执行前先规划",
        bypassPermissions: "跳过所有权限",
      },
    },
    defaultPermissions: {
      title: "默认权限",
      footer:
        "当选择此配置文件时，为新会话覆盖账号级默认权限。",
      accountDefaultSubtitle: ({ label }: { label: string }) =>
        `账号默认：${label}`,
      useAccountDefault: "使用账号默认",
      currently: ({ label }: { label: string }) => `当前：${label}`,
    },
    aiBackend: {
      title: "AI 后端",
      selectAtLeastOneError: "至少选择一个 AI 后端。",
      claudeSubtitle: "Claude 命令行",
      codexSubtitle: "Codex 命令行",
      opencodeSubtitle: "OpenCode 命令行",
      geminiSubtitleExperimental: "Gemini 命令行（实验）",
      auggieSubtitle: "Auggie 命令行",
      qwenSubtitleExperimental: "Qwen Code 命令行（实验）",
      kimiSubtitleExperimental: "Kimi 命令行（实验）",
      kiloSubtitleExperimental: "Kilo 命令行（实验）",
      piSubtitleExperimental: "Pi 命令行（实验）",
      copilotSubtitleExperimental: "GitHub Copilot CLI（实验）",
    },
    tmux: {
      title: "tmux",
      spawnSessionsTitle: "在 tmux 中启动会话",
      spawnSessionsEnabledSubtitle: "会话将在新的 tmux 窗口中启动。",
      spawnSessionsDisabledSubtitle:
        "会话将在普通 shell 中启动（无 tmux 集成）",
      isolatedServerTitle: "隔离的 tmux 服务器",
      isolatedServerEnabledSubtitle: "在隔离的 tmux 服务器中启动会话（推荐）。",
      isolatedServerDisabledSubtitle: "在默认的 tmux 服务器中启动会话。",
      sessionNamePlaceholder: "留空 = 当前/最近会话",
      tempDirPlaceholder: "留空以自动生成",
    },
    previewMachine: {
      title: "预览设备",
      itemTitle: "用于环境变量预览的设备",
      selectMachine: "选择设备",
      resolveSubtitle: "仅用于预览下面解析后的值（不会改变已保存的内容）。",
      selectSubtitle: "选择设备以预览下面解析后的值。",
    },
    environmentVariables: {
      title: "环境变量",
      addVariable: "添加变量",
      namePlaceholder: "变量名（例如 MY_CUSTOM_VAR）",
      valuePlaceholder: "值（例如 my-value 或 ${MY_VAR}）",
      validation: {
        nameRequired: "请输入变量名。",
        invalidNameFormat:
          "变量名必须由大写字母、数字和下划线组成，且不能以数字开头。",
        duplicateName: "该变量已存在。",
      },
      card: {
        valueLabel: "值：",
        fallbackValueLabel: "备用值：",
        valueInputPlaceholder: "值",
        defaultValueInputPlaceholder: "默认值",
        fallbackDisabledForVault: "使用机密保管库时，备用值会被禁用。",
        secretNotRetrieved: "秘密值——出于安全原因不会读取",
        secretToggleLabel: "在 UI 中隐藏值",
        secretToggleSubtitle: "在 UI 中隐藏该值，并避免为预览从机器获取它。",
        secretToggleEnforcedByDaemon: "由守护进程强制",
        secretToggleEnforcedByVault: "由机密保管库强制",
        secretToggleResetToAuto: "重置为自动",
        requirementRequiredLabel: "必需",
        requirementRequiredSubtitle: "当变量缺失时，阻止创建会话。",
        requirementUseVaultLabel: "使用机密保管库",
        requirementUseVaultSubtitle: "使用已保存的机密（不允许备用值）。",
        defaultSecretLabel: "默认机密",
        overridingDefault: ({ expectedValue }: { expectedValue: string }) =>
          `正在覆盖文档默认值：${expectedValue}`,
        useMachineEnvToggle: "使用设备环境中的值",
        resolvedOnSessionStart: "会话在所选设备上启动时解析。",
        sourceVariableLabel: "来源变量",
        sourceVariablePlaceholder: "来源变量名（例如 Z_AI_MODEL）",
        checkingMachine: ({ machine }: { machine: string }) =>
          `正在检查 ${machine}...`,
        emptyOnMachine: ({ machine }: { machine: string }) =>
          `${machine} 上为空`,
        emptyOnMachineUsingFallback: ({ machine }: { machine: string }) =>
          `${machine} 上为空（使用备用值）`,
        notFoundOnMachine: ({ machine }: { machine: string }) =>
          `在 ${machine} 上未找到`,
        notFoundOnMachineUsingFallback: ({ machine }: { machine: string }) =>
          `在 ${machine} 上未找到（使用备用值）`,
        valueFoundOnMachine: ({ machine }: { machine: string }) =>
          `在 ${machine} 上找到值`,
        differsFromDocumented: ({ expectedValue }: { expectedValue: string }) =>
          `与文档值不同：${expectedValue}`,
      },
      preview: {
        secretValueHidden: ({ value }: { value: string }) =>
          `${value} - 出于安全已隐藏`,
        hiddenValue: "***已隐藏***",
        emptyValue: "(空)",
        sessionWillReceive: ({
          name,
          value,
        }: {
          name: string;
          value: string;
        }) => `会话将收到：${name} = ${value}`,
      },
      previewModal: {
        titleWithProfile: ({ profileName }: { profileName: string }) =>
          `环境变量 · ${profileName}`,
        descriptionPrefix:
          "这些环境变量会在启动会话时发送。值会通过守护进程解析于",
        descriptionFallbackMachine: "所选设备",
        descriptionSuffix: "。",
        emptyMessage: "该配置文件未设置环境变量。",
        checkingSuffix: "（检查中…）",
        detail: {
          fixed: "固定",
          machine: "设备",
          checking: "检查中",
          fallback: "备用",
          missing: "缺失",
        },
      },
    },
    delete: {
      title: "删除配置",
      message: ({ name }: { name: string }) =>
        `确定要删除"${name}"吗？此操作无法撤销。`,
      confirm: "删除",
      cancel: "取消",
    },
  },

  secrets: {
    addTitle: "新的机密",
    savedTitle: "已保存的机密",
    badgeReady: "机密",
    badgeRequired: "需要机密",
    missingForProfile: ({ env }: { env: string | null }) =>
      `缺少机密（${env ?? "机密"}）。请在设备上配置，或选择/输入一个机密。`,
    defaultForProfileTitle: "默认机密",
    defineDefaultForProfileTitle: "为此配置文件设置默认机密",
    addSubtitle: "添加已保存的机密",
    noneTitle: "无",
    noneSubtitle: "使用设备环境，或为本次会话输入机密",
    emptyTitle: "没有已保存的机密",
    emptySubtitle:
      "添加一个，以在不设置设备环境变量的情况下使用需要机密的配置。",
    savedHiddenSubtitle: "已保存（值已隐藏）",
    defaultLabel: "默认",
    fields: {
      name: "名称",
      value: "值",
    },
    placeholders: {
      nameExample: "例如：Work OpenAI",
      valueExample: "sk-...",
    },
    validation: {
      nameRequired: "名称为必填项。",
      valueRequired: "值为必填项。",
    },
    actions: {
      replace: "替换",
      replaceValue: "替换值",
      setDefault: "设为默认",
      unsetDefault: "取消默认",
    },
    prompts: {
      renameTitle: "重命名机密",
      renameDescription: "更新此机密的友好名称。",
      replaceValueTitle: "替换机密值",
      replaceValueDescription: "粘贴新的机密值。保存后将不会再次显示。",
      deleteTitle: "删除机密",
      deleteConfirm: ({ name }: { name: string }) =>
        `删除“${name}”？此操作无法撤销。`,
    },
  },

  feed: {
    // Feed notifications for friend requests and acceptances
    friendRequestFrom: ({ name }: { name: string }) =>
      `${name} 向您发送了好友请求`,
    friendRequestGeneric: "新的好友请求",
    friendAccepted: ({ name }: { name: string }) =>
      `您现在与 ${name} 成为了好友`,
    friendAcceptedGeneric: "好友请求已接受",
  },
} as const;
